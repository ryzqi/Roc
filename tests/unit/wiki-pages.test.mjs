import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {unknownExperiment, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
function addSource(f,id='source',text='Synthetic observed result.') {
  f.repository.knowledge.upsertFromSource({id,projectId:f.project.id,sourceType:'experiment',sourceId:id,
    title:`Source ${id}`,content:text,chunks:[{content:text,locator:'table:1'}],embeddingPolicy:'none'});
  return f.repository.evidence.capture({projectId:f.project.id,chunkId:`${id}:chunk:0`});
}
async function scene() {
  const f=createResearchFixture(api,'reading'); f.wiki=f.repository.wiki; f.evidence=addSource(f);
  const artifact=f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',title:'Wiki fixture',path:null});
  f.claim=f.repository.evidence.createClaim({experiment: {...unknownExperiment}, projectId:f.project.id,artifactId:artifact.id,subjectType:'claim',
    content:'Synthetic unreviewed claim.',status:'hypothesis',evidenceIds:[f.evidence.id]});
  f.page=f.wiki.create({projectId:f.project.id,kind:'comparison',title:'Across sources',evidenceIds:[f.evidence.id],claimIds:[f.claim.id]});
  await f.wiki.idle();f.page=f.wiki.read(f.project.id,f.page.page.id);return f;
}
const saveInput=(f,section=f.page.current.sections[0])=>({projectId:f.project.id,pageId:f.page.page.id,
  expectedRevision:f.page.page.revision,expectedBasisDigest:f.page.basisDigest,
  section:{id:section.id,title:section.title,body:section.body,evidenceIds:section.evidenceIds,claimIds:section.claimIds,links:section.links}});
const human=(f,cap,fn)=>api.withResearchHumanContext({capability:`research.wiki.${cap}`,projectId:f.project.id,windowId:7},fn);

test('recompile retains assistant synthesis with old dependencies after source invalidation',async()=>{
  const f=await scene();try {
    const input=saveInput(f,{...f.page.current.sections[0],id:'synthesis'});
    input.section.body='Assistant interpretation from original evidence.';
    f.page=f.wiki.save(input,'assistant');
    const saved=f.page.current.sections.find(section=>section.id==='synthesis');
    f.repository.evidence.invalidateEvidence(f.evidence.id,f.project.id);
    while(f.wiki.compileNext()){}
    const current=f.wiki.read(f.project.id,f.page.page.id);
    assert.equal(current.current.sections.find(section=>section.id==='synthesis')?.body,saved.body);
    assert.deepEqual(current.current.sections.find(section=>section.id==='synthesis')?.dependencies,saved.dependencies);
    assert.equal(current.current.sections.find(section=>section.id==='synthesis').status,'stale');
    assert.ok(current.lint.some(issue=>issue.sectionId==='synthesis'&&issue.code==='stale'));
  }finally{await f.wiki.shutdown();f.close();}
});

test('capture → durable source page → compiled topic → bounded navigation returns original evidence, with no invented review',async()=>{
  const f=await scene();try {
    assert.equal(f.page.page.kind,'comparison');assert.equal(f.page.page.job.status,'ready');
    assert.equal(f.page.current.reason,'compile');assert.equal(f.page.sources[0].excerpt,f.evidence.excerpt);
    assert.equal(f.page.links.length,1);assert.equal((await f.wiki.search(f.project.id,'Synthetic')).pages.length,2);
    const source=f.wiki.follow(f.project.id,f.page.page.id,f.page.page.revision,f.page.links[0].id);
    assert.equal(source.page.kind,'source');assert.equal(source.sources[0].evidenceId,f.evidence.id);
    assert.throws(()=>f.wiki.follow(f.project.id,source.page.id,source.page.revision,f.page.page.id),/link_not_found/);
    assert.equal(f.repository.evidence.getClaim(f.claim.id).status,'hypothesis');
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_evidence_relations WHERE status='confirmed'").pluck().get(),0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_knowledge_documents').pluck().get(),1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_evidence').pluck().get(),1);
  }finally{await f.wiki.shutdown();f.close();}
});

test('CAS and source digest fences protect human sections and reject stale assistant synthesis; rollback keeps stale dependencies',async()=>{
  const f=await scene();try {
    const original=f.page.current, input=saveInput(f);input.section.body='Human maintained interpretation.';
    assert.throws(()=>f.wiki.save(input,'human'),/human_required/);
    f.page=human(f,'save',()=>f.wiki.save(input,'human'));
    assert.throws(()=>f.wiki.save(input,'assistant'),/revision_conflict/);
    assert.throws(()=>f.wiki.save(saveInput(f,f.page.current.sections.find(s=>s.owner==='human')),'assistant'),/human_section_protected/);
    const staleInput=saveInput(f,{...f.page.current.sections[0],id:'synthesis'});
    f.repository.evidence.updateClaim({experiment: {...unknownExperiment}, id:f.claim.id,content:'Changed claim',status:'hypothesis',evidenceIds:[f.evidence.id],expectedVersion:1});
    assert.throws(()=>f.wiki.save(staleInput,'assistant'),/basis_changed/);
    assert.deepEqual(f.wiki.revision(f.project.id,f.page.page.id,1),original);
  }finally{await f.wiki.shutdown();f.close();}
});

test('source invalidation recompiles affected drafts, retains human sections and immutable old revisions',async()=>{
  const f=await scene();try {
    const sourceSection=f.page.current.sections.find(s=>s.evidenceIds.length>0);
    const input=saveInput(f,sourceSection);input.section.body='Human interpretation';
    f.page=human(f,'save',()=>f.wiki.save(input,'human'));
    const before=f.page, staleSave=saveInput(f,{...sourceSection,id:'new-synthesis'});
    addSource(f,'unrelated');while(f.wiki.compileNext()){}
    const unrelated=(await f.wiki.search(f.project.id)).pages.find(p=>p.title==='Source unrelated');
    f.repository.evidence.invalidateEvidence(f.evidence.id,f.project.id);
    assert.equal(f.wiki.read(f.project.id,f.page.page.id).page.job.status,'queued');
    assert.throws(()=>f.wiki.save(staleSave,'assistant'),/basis_changed/);
    while(f.wiki.compileNext()){}
    f.page=f.wiki.read(f.project.id,f.page.page.id);
    assert.equal(f.page.current.sections.find(s=>s.owner==='human').body,'Human interpretation');
    assert.ok(f.page.lint.some(issue=>issue.code==='stale'));
    assert.equal(f.wiki.read(f.project.id,unrelated.id).page.revision,unrelated.revision);
    assert.deepEqual(f.wiki.revision(f.project.id,before.page.id,before.page.revision),before.current);
    const rolled=human(f,'rollback',()=>f.wiki.rollback({projectId:f.project.id,pageId:f.page.page.id,
      expectedRevision:f.page.page.revision,targetRevision:1}));
    assert.equal(rolled.current.reason,'rollback');assert.ok(rolled.lint.some(issue=>issue.code==='stale'));
    assert.equal(rolled.sources[0].status,'superseded');
  }finally{await f.wiki.shutdown();f.close();}
});

test('relations and claim changes invalidate only dependents; conflict candidates never become scientific decisions',async()=>{
  const f=await scene();try {
    const source=f.page.links[0], old=saveInput(f,{...f.page.current.sections[0],id:'synthesis'});
    f.repository.evidence.relations.propose({projectId:f.project.id,claimId:f.claim.id,expectedClaimVersion:1,
      evidenceId:f.evidence.id,expectedSourceDigest:api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.evidence.id,f.project.id)),
      kind:'contradicts',condition:null,supersedesRelationId:null},{kind:'agent',id:f.run.id});
    assert.throws(()=>f.wiki.save(old,'assistant'),/basis_changed/);
    assert.ok(f.wiki.read(f.project.id,f.page.page.id).lint.some(issue=>issue.code==='conflict_candidate'));
    while(f.wiki.compileNext()){}
    assert.equal(f.wiki.read(f.project.id,source.id).page.revision,source.revision);
    const prior=f.wiki.read(f.project.id,f.page.page.id).page.revision;
    f.repository.evidence.updateClaim({experiment: {...unknownExperiment}, id:f.claim.id,content:'Revised unreviewed claim',status:'hypothesis',evidenceIds:[f.evidence.id],expectedVersion:1});
    assert.equal(f.wiki.read(f.project.id,f.page.page.id).page.job.status,'queued');while(f.wiki.compileNext()){}
    assert.equal(f.wiki.read(f.project.id,f.page.page.id).page.revision,prior+1);
    assert.equal(f.repository.evidence.relations.list({projectId:f.project.id,claimId:f.claim.id})[0].status,'invalidated');
  }finally{await f.wiki.shutdown();f.close();}
});

test('compile publication is atomic, failure visible, restart recovers a running job and retry publishes once',async()=>{
  const f=await scene();try {
    const before=f.page.current;
    f.db.exec("CREATE TRIGGER wiki_fail_test BEFORE UPDATE OF revision ON research_wiki_pages BEGIN SELECT RAISE(ABORT,'private payload'); END;");
    f.wiki.recompile(f.project.id,f.page.page.id,f.page.page.revision);await f.wiki.idle();
    assert.equal(f.wiki.read(f.project.id,f.page.page.id).page.job.status,'failed');
    assert.doesNotMatch(f.wiki.read(f.project.id,f.page.page.id).page.job.error,/private/);
    assert.deepEqual(f.wiki.revision(f.project.id,f.page.page.id,before.revision),before);
    assert.equal(f.wiki.history(f.project.id,f.page.page.id).length,1);
    f.db.exec('DROP TRIGGER wiki_fail_test');
    f.db.prepare("UPDATE research_wiki_jobs SET status='running' WHERE page_id=?").run(f.page.page.id);
    f.wiki.start();await f.wiki.idle();
    assert.equal(f.wiki.read(f.project.id,f.page.page.id).page.job.status,'ready');
    assert.equal(f.wiki.history(f.project.id,f.page.page.id).length,2);
  }finally{await f.wiki.shutdown();f.close();}
});

test('trusted IPC binds human authority and project; generated drafts cannot be promoted to human content',async()=>{
  const f=await scene();try {
    const registry=new api.CapabilityRegistry();for(const descriptor of api.researchWikiCapabilities)registry.declare('research',descriptor);
    api.registerResearchWikiCapabilities({pluginId:'research',capabilities:registry},f.wiki,f.repository.paperCards);
    const adapter=api.createPluginCapabilityAdapter({invokeCapability:(...args)=>registry.invoke(...args)});
    const input=saveInput(f);input.section.body='Edited through real IPC';
    const rejected=await adapter.invoke('research.saveWiki',[input],0);assert.equal(rejected.ok,false);
    const saved=await adapter.invoke('research.saveWiki',[input],42);assert.equal(saved.ok,true);assert.equal(saved.data.current.reason,'human');
    const other=f.repository.createProject({title:'Other',description:'',workspacePath:'/tmp/wiki-other'});
    assert.throws(()=>f.wiki.read(other.id,f.page.page.id),/page_not_found/);
    assert.throws(()=>f.wiki.create({projectId:other.id,title:'Wrong scope',kind:'topic',evidenceIds:[f.evidence.id],claimIds:[]}),/project_mismatch/);
  }finally{await f.wiki.shutdown();f.close();}
});

test('assistant revision remains a draft with original references; structural lint reports uncited sections and broken links',async()=>{
  const f=await scene();try {
    const input=saveInput(f,{...f.page.current.sections[0],id:'synthesis'});input.section.body='A synthesis requiring verification.';
    f.page=f.wiki.save(input,'assistant');assert.equal(f.page.current.reason,'assistant');
    assert.equal(f.page.current.sections.find(s=>s.id==='synthesis').owner,'assistant');
    const note=saveInput(f,{...input.section,id:'human-note',evidenceIds:[],claimIds:[],links:[]});
    f.page=human(f,'save',()=>f.wiki.save(note,'human'));
    assert.ok(f.page.lint.some(issue=>issue.code==='uncited'&&issue.sectionId==='human-note'));
    f.db.prepare('DELETE FROM research_wiki_pages WHERE id=?').run(f.page.links[0].id);
    assert.ok(f.wiki.read(f.project.id,f.page.page.id).lint.some(issue=>issue.code==='broken_link'));
    assert.equal(f.repository.evidence.list(f.project.id).length,1);
  }finally{await f.wiki.shutdown();f.close();}
});

test('source ingestion transaction rolls back its Wiki outbox and repeated captures do not duplicate pages',async()=>{
  const f=createResearchFixture(api,'reading');try {
    assert.throws(()=>f.db.transaction(()=>{addSource(f);throw new Error('rollback');})(),/rollback/);
    assert.equal((await f.repository.wiki.search(f.project.id)).pages.length,0);
    const evidence=addSource(f);f.repository.evidence.capture({projectId:f.project.id,chunkId:evidence.chunkId});
    assert.equal((await f.repository.wiki.search(f.project.id)).pages.length,1);
    f.repository.wiki.start();await f.repository.wiki.idle();
    assert.equal((await f.repository.wiki.search(f.project.id)).pages[0].revision,1);
  }finally{await f.repository.wiki.shutdown();f.close();}
});

test('parse outbox generates derived cards, reparse retains prose, and bounded incremental synthesis uses current original blocks',async()=>{
  const f=createResearchFixture(api,'reading'),wiki=f.repository.wiki,cards=f.repository.paperCards;
  const roles=['problem','contribution','method','experimental_setup','results','limitations'];
  const publish=(parse,hash)=>{
    const input={id:`paper:${parse}`,projectId:f.project.id,sourceType:'file',sourceId:'paper.pdf',title:'Paper card fixture',
      content:`Original result ${parse}.`,chunks:[{content:`Original result ${parse}.`,locator:'PDF page 1',
        semantic:{paperId:'paper',parseId:parse,sourceHash:hash,blockId:'original-page',sectionPath:['Results'],
          semanticRole:'results',blockKind:'paragraph',relatedBlockIds:[]}}],embeddingPolicy:'none'};
    f.repository.knowledge.upsertFromSource(input,{fileId:'stable-paper',parseId:parse,sourceHash:hash});
    f.repository.queueKnowledgeFromSource(input);f.repository.flushKnowledgeFromSource();
  };
  try {
    cards.start(async(_title,blocks)=>({sections:roles.map(role=>({role,body:`Derived ${role}.`,chunkIds:[blocks[0].source.chunkId]}))}));
    publish('parse1','a'.repeat(64));await cards.idle();await wiki.idle();
    let page=wiki.read(f.project.id,(await wiki.search(f.project.id)).pages[0].id);
    assert.equal(page.paperJob.status,'ready');assert.equal(page.current.sections.length,6);
    assert.equal(page.current.sections[0].paperSources[0].blockId,'original-page');
    assert.equal(f.repository.evidence.list(f.project.id).length,0);
    assert.throws(()=>f.repository.evidence.capture({projectId:f.project.id,chunkId:`${page.page.id}:paper:results`}),/chunk_not_found/);
    const card=page.current.sections[0];
    page=wiki.save({projectId:f.project.id,pageId:page.page.id,expectedRevision:page.page.revision,
      expectedBasisDigest:page.basisDigest,section:{id:'synthesis',title:'Assistant synthesis',body:'Retained interpretation.',
        evidenceIds:[],claimIds:[],links:[],paperSources:card.paperSources}},'assistant');
    const oldRevision=page.page.revision,old=page.current;
    api.withResearchHumanContext({capability:'research.wiki.save',projectId:f.project.id,windowId:7},()=>wiki.save({
      projectId:f.project.id,pageId:page.page.id,expectedRevision:page.page.revision,expectedBasisDigest:page.basisDigest,
      section:{id:'note',title:'Human note',body:'Keep human prose.',evidenceIds:[],claimIds:[],links:[]}},'human'));
    publish('parse2','b'.repeat(64));await cards.idle();await wiki.idle();
    page=wiki.read(f.project.id,page.page.id);
    assert.equal((await wiki.search(f.project.id)).pages.length,1);
    assert.equal(page.current.sections.find(s=>s.id==='synthesis').status,'stale');
    assert.equal(page.current.sections.find(s=>s.id==='synthesis').body,'Retained interpretation.');
    assert.equal(page.current.sections.find(s=>s.id==='note').body,'Keep human prose.');
    assert.deepEqual(wiki.revision(f.project.id,page.page.id,oldRevision),old);
    const detail=wiki.readSection({projectId:f.project.id,pageId:page.page.id,expectedRevision:page.page.revision,
      sectionId:'synthesis',offset:0,maxChars:100});
    assert.ok(detail.section.body.length<=100);
    wiki.configureSynthesis(async basis=>basis.sections.map(s=>({id:s.id,title:s.title,body:'Updated from parse2.',
      evidenceIds:[],claimIds:[],links:[],paperSources:[basis.originals[0].source]})));
    page=await wiki.resynthesize({projectId:f.project.id,pageId:page.page.id,expectedRevision:page.page.revision,
      expectedBasisDigest:page.basisDigest,sectionIds:['synthesis']});
    assert.equal(page.current.sections.find(s=>s.id==='synthesis').status,'current');
    assert.equal(page.current.sections.find(s=>s.id==='synthesis').paperSources[0].parseId,'parse2');
    f.repository.evidence.capture({projectId:f.project.id,chunkId:'paper:parse2:chunk:0'});await wiki.idle();
    assert.equal((await wiki.search(f.project.id)).pages.length,1);
    cards.start(async()=>({sections:roles.map(role=>({role,body:'Invented reference.',chunkIds:['invented']}))}));
    cards.retry(f.project.id,page.page.id);await cards.idle();
    assert.equal(wiki.read(f.project.id,page.page.id).paperJob.status,'failed');
    assert.equal(f.repository.evidence.list(f.project.id).length,1);
  }finally{await cards.shutdown();await wiki.shutdown();f.close();}
});
