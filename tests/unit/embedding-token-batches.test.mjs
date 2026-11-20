import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, batching, chunkTokenCount, OpenAICompatibleEmbeddingClient;
before(async()=>{
  [api,batching,{chunkTokenCount},{OpenAICompatibleEmbeddingClient}]=await Promise.all([loadResearchTestApi(),
    importTypeScriptModule('src/main/plugins/research/embedding-batches.ts',{platform:'node'}),
    importTypeScriptModule('src/main/plugins/research/knowledge-chunks.ts',{platform:'node'}),
    importTypeScriptModule('src/main/plugins/research/embedding-client.ts',{platform:'node'})]);
});
after(()=>api?.dispose());
const policy={maxItems:3,maxBatchTokens:64,maxInputTokens:32,providerContextTokens:48};
const signal=()=>new AbortController().signal;
const vector=blob=>Array.from({length:blob.length/4},(_,index)=>blob.readFloatLE(index*4));
const closeTo=(actual,expected)=>actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<1e-6));
const normalize=values=>{const length=Math.hypot(...values);return values.map(value=>value/length);};
const response=text=>text.includes('\\')?[2,1,0]:[0,1,3];
test('token/item/context limits preserve every original Unicode, LaTeX and table byte; pooling matches independent arithmetic',async()=>{
  const texts=['\\sum_{i=1}^{n} \\theta_i + \\lambda_i '.repeat(70)+'完 🧪 e\u0301',
    'Method | Accuracy | F1\n'+'Baseline A | 0.812 | 0.804\n'.repeat(40),
    '中文🧪'.repeat(80),'short input','other input'];
  const observations=[];
  const run=async()=>batching.embedTokenBatches(texts,3,async batch=>{
    assert.ok(batch.length<=policy.maxItems);
    assert.ok(batch.reduce((sum,text)=>sum+Math.max(1,chunkTokenCount(text)),0)<=policy.maxBatchTokens);
    assert.ok(batch.every(text=>chunkTokenCount(text)<=32 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(text)));
    observations.push(...batch);
    return batch.map(response);
  },signal(),()=>{},policy);
  const blobs=await run(), first=[...observations];
  assert.equal(observations.join(''),texts.join(''));
  let cursor=0;
  for (const [index,text] of texts.entries()) {
    let reconstructed='',sum=[0,0,0];
    while (reconstructed.length<text.length) {
      const fragment=observations[cursor++];reconstructed+=fragment;
      const unit=normalize(response(fragment)),weight=Math.max(1,chunkTokenCount(fragment));
      sum=sum.map((value,offset)=>value+unit[offset]*weight);
    }
    assert.equal(reconstructed,text);closeTo(vector(blobs[index]),normalize(sum));
  }
  observations.length=0;const repeated=await run();
  assert.deepEqual(observations,first);assert.deepEqual(repeated,blobs);
});
test('only recognized provider limits split batches/inputs; accepted fragments reconstruct exact source',async()=>{
  const texts=['equation '.repeat(60)+'🧪','Table 3 source rows '.repeat(35)];
  const accepted=[],calls=[];
  const blobs=await batching.embedTokenBatches(texts,3,async batch=>{
    calls.push([...batch]);
    if(batch.length>1 || batch.some(text=>chunkTokenCount(text)>10)) throw new Error('embedding_provider_input_limit');
    accepted.push(...batch);return batch.map(()=>[1,2,3]);
  },signal(),()=>{},policy);
  assert.equal(accepted.join(''),texts.join(''));
  assert.ok(calls.length>accepted.length);assert.equal(blobs.length,texts.length);
  for (const error of ['embedding_provider_http_400','embedding_provider_http_401','embedding_provider_http_429','embedding_provider_http_503']) {
    let count=0;
    await assert.rejects(()=>batching.embedTokenBatches(['first','second'],3,async()=>{
      count++;throw new Error(error);
    },signal(),()=>{},policy),new RegExp(error));
    assert.equal(count,1);
  }
  await assert.rejects(()=>batching.embedTokenBatches(['🧪'],3,async()=>{throw new Error('embedding_provider_input_limit');},
    signal(),()=>{},policy),/embedding_input_unsplittable/);
});
test('dimension, nonfinite, zero and count failures are explicit; cancellation/config changes stop further provider calls',async()=>{
  for (const row of [[1,0],[NaN,0,1],[Infinity,0,1],[0,0,0]]) {
    await assert.rejects(()=>batching.embedTokenBatches(['input'],3,async()=>[row],signal(),()=>{},policy),/embedding_vector_invalid/);
  }
  await assert.rejects(()=>batching.embedTokenBatches(['input'],3,async()=>[],signal(),()=>{},policy),/count_mismatch/);
  for (const change of ['cancel','configuration']) {
    const controller=new AbortController();let current=true,calls=0;
    await assert.rejects(()=>batching.embedTokenBatches(['Long input '.repeat(200)],3,async batch=>{
      calls++;if(change==='cancel')controller.abort();else current=false;
      return batch.map(()=>[1,2,3]);
    },controller.signal,()=>{if(!current)throw new Error('research_embedding_config_changed');},policy));
    assert.equal(calls,1);
  }
  await assert.rejects(()=>batching.embedTokenBatches(['input'],3,async()=>[[1,2,3]],signal(),()=>{},
    {...policy,maxBatchTokens:0}),/policy_invalid/);
});
test('HTTP limit classification keeps private payloads out of errors and preserves ordinary bad-request failures',async()=>{
  const config={id:'test',name:'test',baseUrl:'https://fixture.invalid',model:'test',dimensions:3,enabled:true,keyConfigured:true,revision:1};
  for (const [status,payload,expected] of [[400,{error:{code:'context_length_exceeded',message:'private source'}},'embedding_provider_input_limit'],
    [413,{error:'private source'},'embedding_provider_input_limit'],
    [400,{error:{code:'bad_model',message:'private key'}},'embedding_provider_http_400'],
    [400,{error:{message:'private key'}},'embedding_provider_http_400']]) {
    const client=new OpenAICompatibleEmbeddingClient(async()=>new Response(JSON.stringify(payload),{status}));
    await assert.rejects(()=>client.embed({config,apiKey:'private-key',texts:['input']}),error=>{
      assert.equal(error.message,expected);return true;
    });
  }
});
const config={id:'test',name:'test',baseUrl:'https://fixture.invalid',model:'model-one',dimensions:3,enabled:true};
test('production APIs share full version/model/dimension/policy cache identity and reject corrupt cached vectors',async()=>{
  const f=createResearchFixture(api,'reading');let service;
  try {
    f.repository.knowledge.saveEmbeddingConfig(config,'test-secret');
    let calls=0;
    service=new api.ResearchEmbeddingService(f.repository.knowledge,{embed:async({texts})=>{
      calls++;return texts.map(()=>[1,2,3]);
    }},{secrets:{get:async()=>'test-key'},logger:{warn(){}}},undefined,undefined,policy);
    const first=await service.embedTexts(['duplicate','duplicate'],'roc-paper-equation-v1');
    assert.deepEqual(first.vectors[0],first.vectors[1]);assert.equal(calls,1);
    const identity=service.selectedIdentity(null);
    await service.embedInputs([{text:'duplicate',version:'roc-paper-equation-v1'}],identity);
    assert.equal(calls,1);
    await service.embedTexts(['duplicate'],'roc-paper-table-v1');assert.equal(calls,2);
    const rows=f.db.prepare('SELECT input_version FROM research_embedding_cache').all().map(row=>JSON.parse(row.input_version));
    assert.deepEqual(new Set(rows.map(row=>row.inputVersion)),new Set(['roc-paper-equation-v1','roc-paper-table-v1']));
    assert.ok(rows.every(row=>row.configId==='test' && row.revision===1 && row.model==='model-one' &&
      row.dimensions===3 && row.algorithm===batching.embeddingBatchVersion && row.policy.maxInputTokens===32));
    assert.notEqual(batching.embeddingCacheVersion(identity,'v1',policy),
      batching.embeddingCacheVersion({...identity,model:'different'},'v1',policy));
    assert.notEqual(batching.embeddingCacheVersion(identity,'v1',policy),
      batching.embeddingCacheVersion({...identity,dimensions:2},'v1',policy));
    assert.notEqual(batching.embeddingCacheVersion(identity,'v1',policy),
      batching.embeddingCacheVersion(identity,'v1',{...policy,maxInputTokens:16}));
    f.db.prepare('UPDATE research_embedding_cache SET vector_blob=?').run(Buffer.alloc(12));
    await assert.rejects(()=>service.embedTexts(['duplicate'],'roc-paper-equation-v1'),/embedding_vector_invalid/);
    assert.equal(calls,2);
    f.repository.knowledge.saveEmbeddingConfig({...config,model:'model-two'},'test-secret');
    await service.embedTexts(['duplicate'],'roc-paper-equation-v1');assert.equal(calls,3);
    const current=JSON.parse(f.db.prepare('SELECT input_version FROM research_embedding_cache').pluck().get());
    assert.equal(current.revision,2);assert.equal(current.model,'model-two');
  }finally{await service?.shutdown();await f.close();}
});
test('failed later provider fragments cannot cache or publish incomplete inputs',async()=>{
  const f=createResearchFixture(api,'reading');let service;
  try {
    f.repository.knowledge.saveEmbeddingConfig(config,'test-secret');
    let calls=0;
    service=new api.ResearchEmbeddingService(f.repository.knowledge,{embed:async({texts})=>{
      if(++calls===2)throw new Error('embedding_provider_http_503');return texts.map(()=>[1,2,3]);
    }},{secrets:{get:async()=>'test-key'},logger:{warn(){}}},undefined,undefined,{...policy,maxItems:1});
    await assert.rejects(()=>service.embedTexts(['Long original formula '.repeat(300)],'roc-paper-equation-v1'),/http_503/);
    assert.equal(calls,2);assert.equal(f.db.prepare('SELECT count(*) FROM research_embedding_cache').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(),0);
  }finally{await service?.shutdown();await f.close();}
});
test('actual HTTP client limits trigger service splitting and cache only complete original inputs',async()=>{
  const f=createResearchFixture(api,'reading');let service;
  try {
    f.repository.knowledge.saveEmbeddingConfig(config,'test-secret');
    const accepted=[];let rejected=0;
    const client=new OpenAICompatibleEmbeddingClient(async(_url,request)=>{
      const texts=JSON.parse(request.body).input;
      if(texts.length>1 || texts.some(text=>chunkTokenCount(text)>10)) {
        rejected++;
        return new Response(JSON.stringify({error:{code:'context_length_exceeded',message:'private document'}}),{status:400});
      }
      accepted.push(...texts);
      return new Response(JSON.stringify({data:texts.map((_,index)=>({index,embedding:[1,2,3]}))}),{status:200});
    });
    service=new api.ResearchEmbeddingService(f.repository.knowledge,client,
      {secrets:{get:async()=>'test-key'},logger:{warn(){}}},undefined,undefined,policy);
    const texts=['\\theta + \\lambda '.repeat(80)+'🧪 <|endoftext|>','Original table rows '.repeat(50)];
    const result=await service.embedTexts(texts,'http-limit-v1');
    assert.equal(accepted.join(''),texts.join(''));assert.ok(rejected>0);
    assert.equal(result.vectors.length,2);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_embedding_cache').pluck().get(),2);
    const calls=accepted.length;
    assert.deepEqual(await service.embedTexts(texts,'http-limit-v1'),result);
    assert.equal(accepted.length,calls);
  }finally{await service?.shutdown();await f.close();}
});

test('completed original inputs survive a later timeout and resume without publishing a partial document',async()=>{
  const f=createResearchFixture(api,'reading');let service;
  try {
    const knowledge=f.repository.knowledge;
    knowledge.saveEmbeddingConfig(config,'test-secret');
    knowledge.upsertFromSource({id:'resume-document',projectId:f.project.id,sourceType:'file',sourceId:'resume-fixture',
      title:'Resume source',content:'first second third',chunks:['first','second','third'].map((content,index)=>({content,locator:`block:${index}`})),embeddingPolicy:'none'});
    const calls=[];let fail=true;
    service=new api.ResearchEmbeddingService(knowledge,{embed:async({texts})=>{
      calls.push([...texts]);
      if(fail && calls.length===2)throw new Error('embedding_provider_timeout');
      return texts.map(()=>[1,2,3]);
    }},{secrets:{get:async()=>'test-key'},logger:{warn(){}}},undefined,undefined,{...policy,maxItems:1});
    await assert.rejects(()=>service.embedDocument('resume-document',null),/embedding_provider_timeout/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_embedding_cache').pluck().get(),1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(),0);
    fail=false;
    await service.embedDocument('resume-document',null);
    assert.equal(calls.length,4);
    assert.notDeepEqual(calls[2],calls[0]);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_embedding_cache').pluck().get(),3);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(),3);
  }finally{await service?.shutdown();await f.close();}
});

test('checkpoint fences source and config changes before caching provider results',async()=>{
  for(const change of ['title','section','content','configuration']){
    const f=createResearchFixture(api,'reading');let service;
    try{
      const knowledge=f.repository.knowledge;
      knowledge.saveEmbeddingConfig(config,'test-secret');
      knowledge.upsertFromSource({id:'fenced-document',projectId:f.project.id,sourceType:'file',sourceId:'fenced-fixture',
        title:'Fenced source',content:'first second',chunks:['first','second'].map((content,index)=>({content,section:'Original',locator:`block:${index}`})),embeddingPolicy:'none'});
      service=new api.ResearchEmbeddingService(knowledge,{embed:async({texts})=>{
        if(change==='title')f.db.prepare('UPDATE research_knowledge_documents SET title=? WHERE id=?').run('Changed','fenced-document');
        else if(change==='section')f.db.prepare('UPDATE research_knowledge_chunk_structure SET section=?').run('Changed');
        else if(change==='content')f.db.prepare('UPDATE research_knowledge_chunks SET content_hash=? WHERE document_id=?').run('changed','fenced-document');
        else knowledge.saveEmbeddingConfig({...config,model:'changed'},'test-secret');
        return texts.map(()=>[1,2,3]);
      }},{secrets:{get:async()=>'test-key'},logger:{warn(){}}},undefined,undefined,{...policy,maxItems:1});
      await assert.rejects(()=>service.embedDocument('fenced-document',null),error=>/^research_embedding_(source|config)_changed$/u.test(error.code));
      assert.equal(f.db.prepare('SELECT count(*) FROM research_embedding_cache').pluck().get(),0);
      assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(),0);
    }finally{await service?.shutdown();await f.close();}
  }
});

test('provider request grouping stays small without changing semantic fragment or existing cache identity',async()=>{
  const calls=[];
  const texts=Array.from({length:12},(_,index)=>`Complete original source ${index}`);
  await batching.embedTokenBatches(texts,3,async batch=>{calls.push([...batch]);return batch.map(()=>[1,2,3]);},signal(),()=>{});
  assert.deepEqual(calls.map(batch=>batch.length),[4,4,4]);
  assert.equal(calls.flat().join(''),texts.join(''));
  const identity={configId:'test',revision:1,model:'model-one',dimensions:3};
  const before=JSON.stringify({inputVersion:'original-v1',...identity,algorithm:'roc-embedding-cl100k-exact-spans-weighted-v1',
    policy:{maxItems:32,maxBatchTokens:16384,maxInputTokens:8192,providerContextTokens:8192}});
  assert.equal(batching.embeddingCacheVersion(identity,'original-v1'),before);
});

test('derived embeddings resume only whole inputs and no-version probes never persist checkpoints',async()=>{
  const f=createResearchFixture(api,'reading');let service;
  try {
    const knowledge=f.repository.knowledge;knowledge.saveEmbeddingConfig(config,'test-secret');
    const calls=[];let fail=true;
    service=new api.ResearchEmbeddingService(knowledge,{embed:async({texts})=>{
      calls.push([...texts]);if(fail && calls.length===2)throw new Error('embedding_provider_timeout');
      return texts.map(()=>[1,2,3]);
    }},{secrets:{get:async()=>'test-key'},logger:{warn(){}}},undefined,undefined,{...policy,maxItems:1});
    await assert.rejects(()=>service.embedTexts(['first original','second original'],'derived-resume-v1'),/embedding_provider_timeout/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_embedding_cache').pluck().get(),1);
    fail=false;await service.embedTexts(['first original','second original'],'derived-resume-v1');
    assert.deepEqual(calls.map(batch=>batch[0]),['first original','second original','second original']);
    await service.embedTexts(['uncached probe'],null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_embedding_cache').pluck().get(),2);
  }finally{await service?.shutdown();await f.close();}
});

test('later source, config or cancellation changes retain only previously safe checkpoints without partial publication',async()=>{
  for(const change of ['source','configuration','cancel']){
    const f=createResearchFixture(api,'reading');let service;
    try{
      const knowledge=f.repository.knowledge,controller=new AbortController();let calls=0;
      knowledge.saveEmbeddingConfig(config,'test-secret');
      knowledge.upsertFromSource({id:'later-change',projectId:f.project.id,sourceType:'file',sourceId:'later-fixture',
        title:'Original title',content:'first second third',chunks:['first','second','third'].map((content,index)=>({content,locator:`block:${index}`})),embeddingPolicy:'none'});
      service=new api.ResearchEmbeddingService(knowledge,{embed:async({texts})=>{
        if(++calls===2){
          if(change==='source')f.db.prepare('UPDATE research_knowledge_documents SET title=? WHERE id=?').run('Changed title','later-change');
          else if(change==='configuration')knowledge.saveEmbeddingConfig({...config,model:'changed'},'test-secret');
          else controller.abort();
        }
        return texts.map(()=>[1,2,3]);
      }},{secrets:{get:async()=>'test-key'},logger:{warn(){}}},undefined,undefined,{...policy,maxItems:1});
      await assert.rejects(()=>service.embedDocument('later-change',null,controller.signal),error=>/^research_embedding_(source_changed|config_changed|cancelled)$/u.test(error.code));
      assert.equal(calls,2);
      const cached=f.db.prepare('SELECT revision FROM research_embedding_cache').all();
      assert.equal(cached.length,1);
      assert.equal(cached[0].revision,1);
      assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(),0);
    }finally{await service?.shutdown();await f.close();}
  }
});
