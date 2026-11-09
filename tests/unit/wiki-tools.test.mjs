import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});after(()=>api?.dispose());
function scene() {
  const f=createResearchFixture(api,'reading');
  f.repository.knowledge.upsertFromSource({id:'source',projectId:f.project.id,sourceType:'experiment',sourceId:'source',
    title:'Original source',content:'Synthetic evidence.',chunks:[{content:'Synthetic evidence.',locator:'row:1'}],embeddingPolicy:'none'});
  f.evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:'source:chunk:0'});
  f.registry=new api.CapabilityRegistry();for(const c of api.researchWikiCapabilities)f.registry.declare('research',c);
  api.registerResearchWikiCapabilities({pluginId:'research',capabilities:f.registry},f.repository.wiki);
  f.controller=new AbortController();
  f.tools=api.createWikiTools({projectId:f.project.id,signal:f.controller.signal,capabilities:f.registry});
  f.call=async(name,args)=>{
    const result=await f.tools.find(t=>t.name===`research_wiki_${name}`).invoke({type:'tool_call',id:'fixture',name:`research_wiki_${name}`,args});
    return JSON.parse(result.content);
  };
  return f;
}
test('real SDK Wiki tools bind project, navigate citations and publish only generated drafts',async()=>{
  const f=scene();try {
    const created=await f.call('create',{title:'Synthetic topic',kind:'topic',evidenceIds:[f.evidence.id],claimIds:[]});
    await f.repository.wiki.idle();
    const search=await f.call('search',{query:'Synthetic',offset:0});assert.equal(search.pages.length,2);
    const read=await f.call('read',{pageId:created.page.id,offset:0});
    assert.equal(read.derived,true);assert.equal(read.sources[0].evidenceId,f.evidence.id);assert.match(read.fallback,/research_search_knowledge/);
    assert.ok(JSON.stringify(read).length<=12000);
    await assert.rejects(()=>f.call('read',{pageId:created.page.id,offset:0}),/already_read/);
    const follow=await f.call('follow',{pageId:created.page.id,expectedRevision:read.page.revision,targetPageId:read.links[0].id});
    assert.equal(follow.page.kind,'source');
    const saved=await f.call('draft',{pageId:created.page.id,expectedRevision:read.page.revision,expectedBasisDigest:read.basisDigest,
      section:{id:'synthesis',title:'Synthesis',body:`Observed synthetic result [${f.evidence.id}].`,evidenceIds:[f.evidence.id],claimIds:[],links:[]}});
    assert.equal(saved.page.revision,2);assert.equal(f.repository.wiki.read(f.project.id,created.page.id).current.reason,'assistant');
    const lint=await f.call('lint',{pageId:created.page.id,offset:0});assert.match(lint.scope,/不能验证/);
    const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/wiki-tools-other'});
    await assert.rejects(()=>f.call('search',{query:'',offset:0,projectId:other.id}));
    f.controller.abort();await assert.rejects(()=>f.call('search',{query:'',offset:0}));
  }finally{await f.repository.wiki.shutdown();f.close();}
});
test('navigation continues past old per-run quotas and read tools never mutate originals',async()=>{
  const f=scene();try {
    f.repository.wiki.start();await f.repository.wiki.idle();
    const changes=f.db.prepare('SELECT total_changes()').pluck().get();
    for(let i=0;i<12;i++)await f.call('search',{query:'missing',offset:i});
    await f.call('search',{query:'missing',offset:12});
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),changes);
    assert.deepEqual(f.tools.map(t=>t.name).sort(),api.WIKI_TOOL_DESCRIPTORS.map(t=>t.name).sort());
    assert.ok(api.WIKI_TOOL_DESCRIPTORS.filter(t=>t.effectClass!=='none').every(t=>t.executionScopes.join()==='main'));
  }finally{await f.repository.wiki.shutdown();f.close();}
});

test('plan mode retains Wiki navigation but blocks both draft mutations before dispatch',async()=>{
  const f=scene();try {
    const visible=api.filterPlanModeModelTools(f.tools).map(tool=>tool.name);
    assert.ok(visible.includes('research_wiki_read'));assert.ok(!visible.includes('research_wiki_create'));assert.ok(!visible.includes('research_wiki_draft'));
    let dispatched=0;
    const guard=api.createRocPlanRuntimeToolGuardMiddleware();
    for(const name of ['research_wiki_create','research_wiki_draft']) {
      const result=await guard.wrapToolCall({toolCall:{id:'test-plan',name,args:{}}},async()=>{dispatched++;});
      assert.equal(result.status,'error');
    }
    assert.equal(dispatched,0);
  }finally{await f.repository.wiki.shutdown();f.close();}
});
