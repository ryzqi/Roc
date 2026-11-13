import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());

test('knowledge tool keeps ranking in artifact and context locks project, version and total budget',async()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const source={id:'paper',projectId:f.project.id,sourceType:'experiment',sourceId:'paper',
      title:'Experiment',content:'Setup\nResult\nLimitations',embeddingPolicy:'none',
      chunks:[{content:'Dataset X, identical inference budget.',locator:'block:setup'},
        {content:'Result needle improves F1.',locator:'block:result'},
        {content:'Limited to Dataset X.',locator:'block:limits'}]};
    f.repository.knowledge.upsertFromSource(source);
    const tools=api.createResearchTools({projectId:f.project.id,signal:new AbortController().signal,
      capabilities:{invoke:async(name,input)=>name==='research.knowledge.search'
        ? f.repository.knowledge.searchKnowledge({request:input,vector:null})
        : f.repository.knowledge.readContext(input)}});
    const search=await tools.find(tool=>tool.name==='research_search_knowledge').invoke({
      type:'tool_call',id:'search',name:'research_search_knowledge',args:{query:'needle',limit:1}});
    const view=JSON.parse(search.content);
    assert.equal(view.ranking,undefined);
    assert.ok(search.artifact.candidates.length>0);
    assert.ok(JSON.stringify(view).length<JSON.stringify({...view,ranking:search.artifact}).length);
    const hit=view.hits[0], contextTool=tools.find(tool=>tool.name==='research_read_knowledge_context');
    const request={chunkId:hit.chunkId,expectedIndexedVersion:hit.indexedVersion,maxChars:200};
    const result=await contextTool.invoke(request);
    assert.match(result.context.content,/needle/);
    assert.equal(result.neighbors.length,2);
    assert.ok([result.context,...result.neighbors].reduce((sum,item)=>sum+item.content.length,0)<=200);
    await assert.rejects(()=>contextTool.invoke({...request,projectId:'other'}));
    const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/knowledge-other'});
    assert.throws(()=>f.repository.knowledge.readContext({...request,projectId:other.id,neighbors:true}),/project_mismatch/);
    f.repository.knowledge.upsertFromSource({...source,title:'Changed source'});
    await assert.rejects(()=>contextTool.invoke(request),/source_changed/);
  }finally{await f.repository.wiki.shutdown();f.close();}
});
