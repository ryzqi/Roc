import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, module, scientificApi;
before(async () => {
  [api, module, scientificApi] = await Promise.all([loadResearchTestApi(),
    importTypeScriptModule('src/main/plugins/research/literature-acquisition-wiki.ts', {platform:'node'}), loadScientificSearchApi()]);
});
after(() => {api?.dispose(); scientificApi?.dispose();});
const roles = ['problem','contribution','method','experimental_setup','results','limitations'];
const generated = blocks => ({sections:roles.map(role => ({role,body:`Model interpretation for ${role}.`,
  chunkIds:[blocks[0].source.chunkId]}))});
const gate = () => {let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve};};

function fixture() {
  const f = createResearchFixture(api,'reading');
  const wiki = f.repository.wiki, cards = f.repository.paperCards;
  const sidecar = new module.ResearchLiteratureAcquisitionWiki(wiki,cards);
  let calls = 0;
  const start = (generate = async (_title, blocks) => generated(blocks)) => cards.start(async (...args) => {
    calls++; return await generate(...args);
  },{pollMs:60000});
  const publish = (documentId, parseId = 'parse1', {projectId = f.project.id, sourceHash = 'a'.repeat(64), unknown = false} = {}) => {
    const input = {id:`card:${documentId}:${parseId}`,projectId,sourceType:'file',sourceId:`${documentId}.pdf`,
      title:`Original source ${documentId}`,content:`Original result ${documentId} ${parseId}. Conditions: Dataset C, test split.`,
      embeddingPolicy:'none',chunks:[{content:`Original result ${documentId} ${parseId}. Conditions: Dataset C, test split.`,
        locator:'PDF page 1',semantic:{paperId:documentId,parseId,sourceHash,blockId:'original-page',sectionPath:['Results'],
          semanticRole:unknown ? 'unknown' : 'results',blockKind:'paragraph',relatedBlockIds:[]}}]};
    f.repository.knowledge.upsertFromSource(input,{fileId:documentId,parseId,sourceHash});
    f.repository.queueKnowledgeFromSource(input); f.repository.flushKnowledgeFromSource();
    return input.id;
  };
  const batch = (readyDocumentIds, total = 3, overrides = {}) => sidecar.reconcileBatch({projectId:f.project.id,
    batchId:'operation-1',title:'Cited import overview',total,readyDocumentIds,...overrides});
  const settle = async () => {await cards.idle(); await wiki.idle();};
  return {...f,wiki,cards,sidecar,start,publish,batch,settle,calls:()=>calls};
}

test('source readiness requires a generated, compiled, current six-role publication, not mere page existence', async () => {
  const f = fixture(), started = gate(), release = gate();
  try {
    assert.equal(f.sidecar.ensureSource(f.project.id,'doc1').status,'missing');
    f.publish('doc1');
    const pending = f.sidecar.ensureSource(f.project.id,'doc1');
    assert.equal(pending.ready,false); assert.equal(pending.error.code,'wiki_paper_card_pending');
    f.start(async (_title,blocks) => {started.resolve(); await release.promise; return generated(blocks);});
    await started.promise; await f.wiki.idle();
    assert.equal(f.sidecar.readSource(f.project.id,'doc1').ready,false);
    release.resolve(); await f.settle();
    const ready = f.sidecar.readSource(f.project.id,'doc1');
    assert.equal(ready.ready,true); assert.equal(ready.publication,'wiki_page'); assert.ok(ready.revision>0);
    assert.ok(ready.generation); assert.equal(f.wiki.read(f.project.id,ready.pageId).current.sections.length,6);
    const before = f.wiki.history(f.project.id,ready.pageId);
    f.sidecar.ensureSource(f.project.id,'doc1'); await f.settle();
    assert.deepEqual(f.wiki.history(f.project.id,ready.pageId),before); assert.equal(f.calls(),1);
  } finally {release.resolve(); await f.close();}
});

test('one scoped durable batch increments partial coverage, cites original excerpts and is idempotent', async () => {
  const f = fixture();
  try {
    f.start(); f.publish('doc1'); await f.settle();
    const first = f.batch(['doc1']);
    assert.equal(first.ready,true); assert.equal(first.status,'partial');
    assert.deepEqual(first.coverage,{total:3,readySources:1,covered:1,missing:2,complete:false});
    const original = f.wiki.revision(f.project.id,first.pageId,first.revision);
    assert.match(original.sections[1].body,/Original result doc1 parse1/);
    assert.match(original.sections[1].body,/PDF page 1/);
    assert.doesNotMatch(original.sections[1].body,/Model interpretation/);
    assert.equal(original.sections[1].paperSources[0].documentId,'doc1');
    const indexed = f.db.prepare('SELECT * FROM research_wiki_sections WHERE page_id=?').all(first.pageId);
    assert.equal(f.batch(['doc1']).revision,first.revision);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_wiki_sections WHERE page_id=?').all(first.pageId),indexed);
    f.publish('doc2'); await f.settle();
    const second = f.batch(['doc2']);
    assert.equal(second.pageId,first.pageId); assert.equal(second.coverage.covered,2);
    f.publish('doc3'); await f.settle();
    const final = f.batch(['doc3']);
    assert.equal(final.status,'ready'); assert.equal(final.coverage.complete,true);
    assert.equal(f.batch([]).revision,final.revision);
    assert.deepEqual(f.wiki.revision(f.project.id,first.pageId,first.revision),original);
    assert.equal(f.repository.evidence.list(f.project.id).length,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_claims').pluck().get(),0);
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_evidence_relations WHERE status='confirmed'").pluck().get(),0);
    const restarted = new module.ResearchLiteratureAcquisitionWiki(f.wiki,f.cards);
    assert.deepEqual(restarted.readBatch(f.project.id,'operation-1'),final);
    f.wiki.recompile(f.project.id,final.pageId,final.revision); await f.wiki.idle();
    assert.equal(restarted.readBatch(f.project.id,'operation-1').revision,final.revision);
  } finally {await f.close();}
});

test('unknown reading roles remain explicit and source edits queue only the owning operation topics', async () => {
  const f = fixture();
  try {
    f.start(async (_title,blocks) => ({sections:generated(blocks).sections.map(section=>section.role==='limitations'
      ? {...section,body:'unknown',chunkIds:[]} : section)}));
    f.publish('doc1'); await f.settle();
    const batch = f.batch(['doc1'],1);
    assert.equal(batch.ready,true);
    let page = f.wiki.read(f.project.id,batch.pageId);
    assert.match(page.current.sections.find(section=>section.id==='acquisition:limitations:0').body,/unknown/);
    assert.equal(page.current.sections.find(section=>section.id==='acquisition:limitations:0').paperSources.length,0);
    const source = f.sidecar.readSource(f.project.id,'doc1');
    page = f.wiki.read(f.project.id,source.pageId);
    const input = {id:'human-note',title:'Human source note',body:'Keep this source annotation.',evidenceIds:[],claimIds:[],links:[]};
    page = save(f,page,input,'human'); await f.wiki.idle();
    assert.equal(f.sidecar.readSource(f.project.id,'doc1').ready,true);
    assert.equal(f.sidecar.readBatch(f.project.id,'operation-1').ready,true);
    assert.equal(f.sidecar.readBatch(f.project.id,'operation-1').revision,batch.revision);
    assert.equal(f.wiki.read(f.project.id,source.pageId).current.sections.find(section=>section.id==='human-note').body,input.body);
    assert.equal(f.calls(),1);
    const renamed = f.batch([],1,{title:'RetitledImportOverview'});
    assert.equal(renamed.revision,batch.revision);
    assert.ok((await f.wiki.search(f.project.id,'RetitledImportOverview')).pages.some(item=>item.id===batch.pageId));
  } finally {await f.close();}
});

test('pending candidates remain dependencies and are incorporated automatically after source compilation', async () => {
  const f = fixture(), started = gate(), release = gate();
  try {
    f.publish('doc1');
    const initial = f.batch(['doc1']);
    assert.equal(initial.ready,false); assert.equal(initial.coverage.covered,0);
    f.start(async (_title,blocks) => {started.resolve(); await release.promise; return generated(blocks);});
    await started.promise; await f.wiki.idle();
    assert.equal(f.sidecar.readBatch(f.project.id,'operation-1').ready,false);
    release.resolve(); await f.settle();
    const current = f.sidecar.readBatch(f.project.id,'operation-1');
    assert.equal(current.ready,true); assert.equal(current.coverage.covered,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_wiki_dependencies WHERE page_id=? AND kind='paper'")
      .pluck().get(current.pageId),1);
  } finally {release.resolve(); await f.close();}
});

const save = (f, page, section, owner) => {
  const input = {projectId:f.project.id,pageId:page.page.id,expectedRevision:page.page.revision,
    expectedBasisDigest:page.basisDigest,section};
  return owner === 'human' ? api.withResearchHumanContext({capability:'research.wiki.save',projectId:f.project.id,windowId:7},
    () => f.wiki.save(input,'human')) : f.wiki.save(input,'assistant');
};
test('incremental regeneration preserves human overrides, assistant sections and immutable history', async () => {
  const f = fixture();
  try {
    f.start(); f.publish('doc1'); await f.settle();
    const first = f.batch(['doc1']);
    let page = f.wiki.read(f.project.id,first.pageId);
    const {owner:_owner,status:_status,dependencies:_deps,...section} = page.current.sections[1];
    page = save(f,page,{...section,id:'assistant-note',body:'Assistant note with original reference.'},'assistant');
    page = save(f,page,{...section,body:'Human maintained role section.'},'human');
    const human = page.current.sections.find(s=>s.owner==='human');
    const assistant = page.current.sections.find(s=>s.owner==='assistant');
    const history = page.current;
    f.publish('doc2'); await f.settle();
    const second = f.batch(['doc2']);
    page = f.wiki.read(f.project.id,second.pageId);
    assert.deepEqual(page.current.sections.find(s=>s.owner==='human'),human);
    assert.deepEqual(page.current.sections.find(s=>s.owner==='assistant'),assistant);
    assert.deepEqual(f.wiki.revision(f.project.id,second.pageId,history.revision),history);
    const coverage = page.current.sections.find(s=>s.id==='acquisition:coverage');
    const {owner:_o,status:_s,dependencies:_d,...input} = coverage;
    page = save(f,page,{...input,body:'My custom coverage.'},'human');
    const held = f.batch([]);
    assert.equal(held.ready,false); assert.equal(held.error.code,'wiki_topic_human_override');
    assert.equal(f.wiki.read(f.project.id,held.pageId).current.sections.find(s=>s.id===coverage.id).body,'My custom coverage.');
  } finally {await f.close();}
});

test('reparse and altered indexed bytes invalidate old dependencies; recovery never blesses retained prose', async () => {
  const f = fixture();
  try {
    f.start(); const knowledgeId = f.publish('doc1'); await f.settle();
    const first = f.batch(['doc1'],1), old = f.wiki.revision(f.project.id,first.pageId,first.revision);
    f.db.prepare('UPDATE research_knowledge_chunks SET content=? WHERE document_id=?').run('tampered bytes',knowledgeId);
    assert.equal(f.sidecar.readSource(f.project.id,'doc1').ready,false);
    const stale = f.sidecar.readBatch(f.project.id,'operation-1');
    assert.equal(stale.ready,false); assert.equal(stale.coverage.covered,0);
    assert.ok(f.wiki.read(f.project.id,first.pageId).current.sections.some(s=>s.status==='stale'));
    f.publish('doc1','parse2',{sourceHash:'b'.repeat(64)});
    assert.equal(f.sidecar.readBatch(f.project.id,'operation-1').ready,false);
    await f.settle();
    const fresh = f.sidecar.readBatch(f.project.id,'operation-1');
    assert.equal(fresh.ready,true); assert.equal(fresh.coverage.complete,true);
    assert.match(f.wiki.read(f.project.id,first.pageId).current.sections[1].body,/parse2/);
    assert.deepEqual(f.wiki.revision(f.project.id,first.pageId,first.revision),old);
  } finally {await f.close();}
});

test('topic failure rolls back revisions and search and retries independently of Paper Card generation', async () => {
  const f = fixture();
  try {
    f.start(); f.publish('doc1'); await f.settle(); const first = f.batch(['doc1']);
    const before = f.wiki.revision(f.project.id,first.pageId,first.revision);
    const search = f.db.prepare('SELECT * FROM research_wiki_sections WHERE page_id=?').all(first.pageId);
    f.publish('doc2'); await f.settle(); const calls = f.calls();
    f.db.exec(`CREATE TRIGGER wiki_batch_fail BEFORE UPDATE OF revision ON research_wiki_pages
      WHEN new.kind='topic' BEGIN SELECT RAISE(ABORT,'private source path'); END;`);
    const failed = f.batch(['doc2']);
    assert.equal(failed.status,'failed'); assert.equal(failed.error.code,'wiki_topic_failed');
    assert.equal(failed.revision,first.revision);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_wiki_sections WHERE page_id=?').all(first.pageId),search);
    assert.deepEqual(f.wiki.revision(f.project.id,first.pageId,first.revision),before);
    assert.doesNotMatch(f.wiki.read(f.project.id,first.pageId).page.job.error,/private/);
    f.db.exec('DROP TRIGGER wiki_batch_fail');
    const retry = f.batch([]); assert.equal(retry.ready,true); assert.equal(retry.coverage.covered,2);
    assert.equal(f.calls(),calls);
    f.db.prepare("UPDATE research_wiki_jobs SET status='running' WHERE page_id=?").run(first.pageId);
    f.wiki.start(); await f.wiki.idle();
    assert.equal(f.sidecar.readBatch(f.project.id,'operation-1').revision,retry.revision);
  } finally {await f.close();}
});

test('source failure and retry use existing card and Wiki queues without redoing imports or PDFs', async () => {
  const f = fixture(); let fail = true;
  try {
    f.start(async (_title,blocks) => {if (fail) throw new Error('private failure'); return generated(blocks);});
    f.publish('doc1'); await f.settle();
    const failed = f.sidecar.readSource(f.project.id,'doc1');
    assert.equal(failed.status,'failed'); assert.equal(failed.error.code,'wiki_paper_card_failed');
    f.sidecar.ensureSource(f.project.id,'doc1'); await f.settle(); assert.equal(f.calls(),1);
    fail = false; f.sidecar.retrySource(f.project.id,'doc1'); await f.settle();
    const ready = f.sidecar.readSource(f.project.id,'doc1'); assert.equal(ready.ready,true); assert.equal(f.calls(),2);
    f.db.exec(`CREATE TRIGGER wiki_source_fail BEFORE UPDATE OF revision ON research_wiki_pages
      WHEN new.kind='source' BEGIN SELECT RAISE(ABORT,'compile fault'); END;`);
    f.wiki.recompile(f.project.id,ready.pageId,ready.revision); await f.wiki.idle();
    assert.equal(f.sidecar.readSource(f.project.id,'doc1').error.code,'wiki_source_failed');
    f.db.exec('DROP TRIGGER wiki_source_fail');
    f.sidecar.retrySource(f.project.id,'doc1'); await f.settle();
    assert.equal(f.sidecar.readSource(f.project.id,'doc1').ready,true); assert.equal(f.calls(),2);
  } finally {await f.close();}
});

test('project isolation prevents foreign or unlinked global sources from satisfying readiness', async () => {
  const f = fixture();
  try {
    f.start(); f.publish('doc1'); f.publish('unlinked','parse1',{projectId:null}); await f.settle();
    const other = f.repository.createProject({title:'Other project',description:'',workspacePath:'/tmp/wiki-sidecar-other'});
    assert.equal(f.sidecar.ensureSource(other.id,'doc1').status,'missing');
    assert.equal(f.sidecar.ensureSource(other.id,'unlinked').status,'missing');
    assert.equal((await f.wiki.search(other.id)).pages.length,0);
    const foreign = f.sidecar.reconcileBatch({projectId:other.id,batchId:'operation-1',title:'Foreign',total:1,readyDocumentIds:['doc1']});
    assert.equal(foreign.ready,false); assert.equal(foreign.coverage.covered,0);
    assert.notEqual(foreign.pageId,module.acquisitionWikiPageId(f.project.id,'operation-1'));
  } finally {await f.close();}
});

test('library-only produces a verified global Paper Card publication and explicitly blocks Topic without a project', async () => {
  const f = fixture(); let fail = true;
  try {
    f.start(async (_title,blocks) => {if (fail) throw new Error('model offline'); return generated(blocks);});
    f.publish('librarydoc','parse1',{projectId:null}); await f.settle();
    assert.equal(f.sidecar.ensureSource(null,'librarydoc').error.code,'wiki_paper_card_failed');
    fail = false; f.sidecar.retrySource(null,'librarydoc'); await f.settle();
    const ready = f.sidecar.readSource(null,'librarydoc');
    assert.equal(ready.ready,true); assert.equal(ready.publication,'paper_card');
    assert.equal(ready.pageId,null); assert.equal(ready.revision,0); assert.ok(ready.generation);
    const read = f.sidecar.readLibrarySource('librarydoc'); assert.equal(read.sections.length,6);
    assert.equal(read.sections[0].paperSources[0].documentId,'librarydoc');
    assert.equal(f.sidecar.readSource(null,'doc1').ready,false);
    const topic = f.batch(['librarydoc'],1,{projectId:null});
    assert.equal(topic.status,'blocked'); assert.equal(topic.error.code,'wiki_project_required'); assert.equal(topic.pageId,null);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_wiki_pages').pluck().get(),0);
  } finally {await f.close();}
});

test('real Document publication is bound to project membership, active parse and original indexed source', async () => {
  const f = await scientificSearchFixture(scientificApi,{embedded:false});
  try {
    f.repository.paperCards.start(async (_title,blocks) => generated(blocks),{pollMs:60000});
    const sidecar = new module.ResearchLiteratureAcquisitionWiki(f.repository.wiki,f.repository.paperCards);
    sidecar.ensureSource(f.project.id,f.document.id); await f.repository.paperCards.idle(); await f.repository.wiki.idle();
    assert.equal(sidecar.readSource(f.project.id,f.document.id).ready,true);
    assert.equal(sidecar.readSource(null,f.document.id).ready,true);
    const initial = sidecar.reconcileBatch({projectId:f.project.id,batchId:'document-operation',title:'Actual source',total:1,
      readyDocumentIds:[f.document.id]});
    assert.equal(initial.ready,true);
    f.repository.documents.begin(f.document.id,'next-parse');
    assert.equal(sidecar.readSource(f.project.id,f.document.id).ready,false);
    assert.equal(sidecar.readBatch(f.project.id,'document-operation').ready,false);
    f.repository.documents.fail(f.document.id,'next-parse','controlled failed reparse',false);
    await f.publish(); await f.repository.paperCards.idle(); await f.repository.wiki.idle();
    sidecar.ensureSource(f.project.id,f.document.id); await f.repository.paperCards.idle(); await f.repository.wiki.idle();
    assert.equal(sidecar.readBatch(f.project.id,'document-operation').coverage.complete,true);
    f.db.prepare('DELETE FROM research_library_projects WHERE project_id=? AND item_id=?').run(f.project.id,f.document.libraryItemId);
    assert.equal(sidecar.readSource(f.project.id,f.document.id).ready,false);
  } finally {await f.close();}
});

test('input and generated page budgets are bounded at 50 papers and never silently truncate selected evidence', async () => {
  const f = fixture();
  try {
    assert.throws(()=>f.batch(['one','two'],1),/wiki_batch_source_limit/);
    assert.throws(()=>f.batch(Array.from({length:51},(_,i)=>`d${i}`),100),/50/);
    const snapshots = Array.from({length:50},(_,i)=>({receipt:{documentId:`doc${i}`},version:'a'.repeat(64),
      page:{page:{id:`page${i}`,title:'T'.repeat(300)}},
      sections:roles.map(role=>({id:`paper:${role}`,body:'derived',paperSources:[{chunkId:`chunk${i}`}]})),
      originals:[{source:{chunkId:`chunk${i}`,locator:'P'.repeat(200)},text:'Original text '.repeat(500)}]}));
    const sections = module.acquisitionWikiSections({batchId:'bounded',total:50,documentIds:[]},snapshots);
    assert.ok(sections.length<=100); assert.ok(sections.every(section=>section.body.length<=6000));
    assert.ok(sections.reduce((sum,section)=>sum+section.body.length,0)<=100000);
    assert.ok(sections.every(section=>(section.paperSources?.length??0)<=12));
  } finally {await f.close();}
});
