import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi,scientificSearchFixture,hash} from './fixtures/scientific-search-fixture.mjs';
let api;
before(async()=>{api=await loadScientificSearchApi();});
after(()=>api?.dispose());

test('six channels retain raw cells, complete equations, figure captions and saved citation source receipts',async()=>{
  const f=await scientificSearchFixture(api);
  const transport=new api.LiteratureSearchService(async()=>Response.json({message:{DOI:f.metadata.doi,
    reference:[{DOI:'10.1234/original-reference'}]}}));
  const service=new api.ScholarlyRelationsService(f.scholarly,transport,()=> '2026-11-17T00:00:00.000Z');
  try {
    const item=f.repository.library.get(f.document.libraryItemId);
    const snapshot=await service.capture({projectId:f.project.id,itemId:item.id,expectedRevision:item.revision,
      requestId:'fixture-citation',sources:['crossref'],offset:0,limit:10});
    const result=await f.router.search(f.request('Compare Dataset C F1 in Table 3, Equation (7), Figure 2 and citations.'));
    assert.deepEqual(new Set(result.channels.map(c=>c.channel)),new Set(['text','metadata','table','equation','figure','citation']));
    assert.ok(result.channels.every(c=>c.returned<=c.limit && c.limit===100));
    assert.ok(result.candidates.every(c=>c.generationId===f.generation.id && c.documentId===f.document.id));
    const tables=result.candidates.filter(c=>c.object.kind==='table').map(c=>c.object);
    const table=tables.find(t=>t.cells.some(c=>c.text==='90'));
    assert.ok(table);
    assert.equal(table.number,'3');assert.deepEqual(table.columns.map(c=>c.header),['Method','F1 (%)']);
    for(const cell of table.cells) {
      const original=f.ir.tables[0].cells.find(c=>c.id===cell.id);
      assert.equal(cell.text,original.text);assert.equal(cell.row,original.row);assert.equal(cell.column,original.column);
      assert.deepEqual(cell.sourceLocator,original.sourceLocator);
    }
    assert.ok(table.cells.some(c=>['90','91'].includes(c.text)));
    assert.ok(tables.some(t=>t.cells.some(c=>c.text==='91')));
    const equation=result.candidates.find(c=>c.object.kind==='equation').object.data;
    assert.equal(equation.rawLatex,'x = y \\tag{7}');assert.equal(equation.equationNumber,'7');
    assert.ok(equation.variables.some(v=>v.definition.includes('original input')));
    const figure=result.candidates.find(c=>c.object.kind==='figure').object.data;
    assert.equal(figure.objectNumber,'2');assert.ok(figure.captions.some(c=>c.evidence.text.includes('Original architecture')));
    const citation=result.candidates.find(c=>c.object.kind==='citation').object;
    assert.equal(citation.snapshotId,snapshot.id);assert.equal(citation.contentHash,snapshot.contentHash);
    assert.equal(citation.queriedAt,snapshot.queriedAt);assert.equal(citation.relation.object.value,'10.1234/original-reference');
    await f.router.assertCurrent(result);
    assert.equal(hash(await readFile(f.source)),hash(f.bytes));
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  } finally {await service.shutdown();await transport.shutdown();await f.close();}
});
test('real native PDF text searches the actual FTS and sqlite-vec index without generic chunk IDs',async()=>{
  const f=await scientificSearchFixture(api,{objects:false});
  try {
    const result=await f.router.search(f.request('Original method'));
    assert.ok(result.hits.some(c=>c.content.includes('Original method')));
    assert.ok(result.candidates.some(c=>c.signals.some(s=>s.method==='fts')));
    assert.ok(result.candidates.some(c=>c.signals.some(s=>s.method==='dense')));
    assert.ok(result.candidates.filter(c=>c.chunkId).every(c=>!f.db.prepare('SELECT 1 FROM research_knowledge_chunks WHERE id=?').get(c.chunkId)));
  } finally {await f.close();}
});

test('scientific text tolerates script, phonetic and compound spellings with dense retrieval disabled and original snapshots intact', async () => {
  const text = 'Multi‑Agent 注意力機制处理重慶绿色网络。';
  const f = await scientificSearchFixture(api, {objects:false,embedded:false,extraParagraphs:[{heading:'3 Method',text}]});
  try {
    const original = f.db.prepare(`SELECT generation_id,id,content,content_hash,embedding_text,embedding_text_hash,chunk_json
      FROM research_scientific_chunks ORDER BY generation_id,id`).all();
    for (const query of ['MULTI-AGENT', 'multi agent', 'multiagent', '注意力机制', 'zhuyili', 'zhu yi li', 'zyl', 'chongqing', 'lǜ sè']) {
      const result = await f.router.search(f.request(query));
      const hit = result.hits.find(candidate => candidate.content.includes(text));
      assert.ok(hit, query);
      assert.equal(hit.generationId, f.generation.id, query);
      assert.equal(hit.documentId, f.document.id, query);
      assert.equal(hit.sourceLocator.parseId, f.ir.identity.parseId, query);
      assert.equal(hit.sourceLocator.parseHash, f.ir.identity.parseHash, query);
      assert.ok(hit.signals.some(signal => ['lexical','fts'].includes(signal.method)), query);
      assert.ok(result.candidates.every(candidate => candidate.generationId === f.generation.id), query);
      assert.deepEqual(result.channels.find(channel => channel.channel === 'text').degradation, ['dense_not_configured']);
      await f.router.assertCurrent(result);
    }
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.db.prepare(`SELECT generation_id,id,content,content_hash,embedding_text,embedding_text_hash,chunk_json
      FROM research_scientific_chunks ORDER BY generation_id,id`).all(), original);
    assert.equal(hash(await readFile(f.source)), hash(f.bytes));
    const workspace = join(f.root, 'tolerant-foreign');
    await mkdir(workspace);
    const foreign = f.repository.createProject({title:'Foreign',description:'',workspacePath:workspace,language:'en'});
    const isolated = await f.router.search({...f.request('zhuyili'),projectId:foreign.id});
    assert.equal(isolated.candidates.length, 0);
  } finally {await f.close();}
});
test('empty DOI, exact object number, year and absent embeddings cannot expand scope',async()=>{
  const f=await scientificSearchFixture(api,{embedded:false});
  try {
    const none=await f.router.search(f.request('DOI:10.9999/unresolved Table 3'));
    assert.equal(none.plan.scope.selection,'none');assert.equal(none.candidates.length,0);assert.equal(none.snapshot.generations.length,0);
    assert.equal((await f.router.search(f.request('Table 30'))).candidates.filter(c=>c.object.kind==='table').length,0);
    assert.equal((await f.router.search(f.request('Original method in 2025 Table 3'))).candidates.length,0);
    const result=await f.router.search(f.request('Table 3'));
    assert.ok(result.hits.some(c=>c.object.kind==='table'));
    const numeric=await f.router.search(f.request('F1 91 Table 3'));
    assert.ok(numeric.candidates.find(c=>c.object.kind==='table').object.cells.some(c=>c.text==='91'));
    assert.deepEqual(result.channels.find(c=>c.channel==='text').degradation,['dense_not_configured']);
    assert.equal(f.calls(),0);
    await assert.rejects(f.router.search({...f.request('method'),documentIds:['foreign']}),/scope_invalid/);
    const workspace=join(f.root,'foreign-workspace');await mkdir(workspace);
    const foreign=f.repository.createProject({title:'Foreign',description:'',workspacePath:workspace,language:'en'});
    const isolated=await f.router.search({...f.request('Table 3'),projectId:foreign.id});
    assert.equal(isolated.candidates.length,0);
  } finally {await f.close();}
});
test('transient embedding failures preserve lexical hits and cancellation rejects the whole request',async()=>{
  const f=await scientificSearchFixture(api);
  try {
    f.provider(async()=>{throw new Error('embedding_provider_http_429');});
    const result=await f.router.search(f.request('Original method'));
    assert.ok(result.hits.length>0);assert.deepEqual(result.channels.find(c=>c.channel==='text').degradation,['rate_limit']);
    const controller=new AbortController();controller.abort(new Error('fixture-cancel'));
    await assert.rejects(f.router.search(f.request('Table 3'),controller.signal),/fixture-cancel/);
    let enter;const entered=new Promise(resolve=>{enter=resolve;});
    f.provider(async(_,signal)=>{enter();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
    const active=new AbortController(),pending=f.router.search(f.request('Original method'),active.signal);
    await entered;active.abort(new Error('fixture-active-cancel'));
    await assert.rejects(pending,error=>error.code==='research_embedding_cancelled');
  } finally {await f.close();}
});
test('source, project membership, parse publication and IR changes during embedding reject stale evidence',async()=>{
  for(const change of ['source','membership','parse','IR']) {
    const f=await scientificSearchFixture(api);let release;
    try {
      const saved=await f.router.search(f.request('Table 3'));
      let enter;const entered=new Promise(resolve=>{enter=resolve;});
      const wait=new Promise(resolve=>{release=resolve;});
      f.provider(async texts=>{enter();await wait;return texts.map(()=>[1,0,0]);});
      const operation=f.router.search(f.request('Original method'));
      const rejected=assert.rejects(operation,error=>error.code==='research_embedding_cancelled' ||
        /source_changed|scope_invalid|source_size|source_hash|artifact_changed/.test(error.message));
      await entered;
      if(change==='source') await writeFile(f.source,Buffer.concat([f.bytes,Buffer.from('\n% source changed')]));
      if(change==='membership') f.repository.library.link(f.document.libraryItemId,f.project.id,false,{notify:true});
      if(change==='parse') await f.publish();
      if(change==='IR') await writeFile(join(f.root,f.data.paperIR.path),'corrupt');
      release();await rejected;
      await assert.rejects(f.router.assertCurrent(saved),/source_changed|scope_invalid|source_size|source_hash|artifact_changed/);
    } finally {release?.();await f.close();}
  }
});

test('Han terms find embedded scientific keywords in an unspaced question with a bounded vocabulary',async()=>{
  const terms=api.scientificQueryTerms('请比较图神经网络的实验结果与局限性');
  for(const term of ['实验','结果','局限']) assert.ok(terms.includes(term),term);
  assert.ok(terms.length<=32);
  assert.equal(api.scientificQueryTerms('网络'.repeat(4000)).length<=32,true);
  assert.deepEqual(api.scientificQueryTerms('F1 Dataset_C 2026'),['f1','dataset_c','2026']);
});
test('a planned subquery preserves scope and query receipts and rejects forged scope before retrieval',async()=>{
  const {scientificSubqueryPlan}=await importTypeScriptModule('src/main/plugins/research/scientific-query-planner.ts',{platform:'node'});
  const f=await scientificSearchFixture(api,{embedded:false});
  try {
    const request=f.request('method and results');
    const plan=await f.router.plan(request);
    const sub=scientificSubqueryPlan(plan,plan.subQuestions[0]);
    const result=await f.router.search({...request,query:sub.query},new AbortController().signal,sub);
    assert.equal(result.plan.query,sub.query);
    await f.router.readContext({search:result});
    const refs=await f.router.sourceRefs(result);
    assert.ok(refs.length>0);assert.ok(refs.every(ref=>ref.generationId===f.generation.id));
    await assert.rejects(f.router.search(request,new AbortController().signal,sub),/plan_scope_invalid/);
    await assert.rejects(f.router.search({...request,query:sub.query},new AbortController().signal,
      {...sub,scope:{...sub.scope,projectId:'foreign'}}),/plan_scope_invalid/);
    await assert.rejects(f.router.search({...request,query:sub.query},new AbortController().signal,
      {...sub,scope:{...sub.scope,documentIds:['foreign']}}),/plan_scope_invalid/);
  } finally {await f.close();}
});

test('Chinese keyword decomposition improves controlled lexical recall against the previous whole-query match',async()=>{
  const text='图神经网络使用多头注意力完成节点分类。';
  const f=await scientificSearchFixture(api,{embedded:false,extraParagraphs:[{heading:'3 Method',text}]});
  try {
    const query='图神经网络的注意力机制是什么';
    const previousTerms=query.match(/[\p{L}\p{N}_]+/gu);
    assert.equal(f.repository.scientificIndex.lexicalHits([f.generation.id],previousTerms,100).length,0);
    const result=await f.router.search({...f.request(query),rerank:'none'});
    assert.ok(result.hits.some(hit=>hit.content===text));
    assert.equal(result.plan.observation.calls,0);
    await f.router.assertCurrent(result);
  } finally {await f.close();}
});
