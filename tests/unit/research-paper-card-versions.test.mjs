import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, cardsApi, scientificApi;
before(async () => {
  [api, cardsApi, scientificApi] = await Promise.all([
    loadResearchTestApi(), importTypeScriptModule('src/main/plugins/research/paper-card-service.ts',
      {platform:'node',tempDir:'.runtime/tmp',external:['@napi-rs/canvas']}),
    loadScientificSearchApi()
  ]);
});
after(() => {api?.dispose(); scientificApi?.dispose();});
const roles = ['problem','contribution','method','experimental_setup','results','limitations'];
const result = (blocks, body = 'Original cited reading.') => ({
  sections:roles.map(role => ({role,body,chunkIds:[blocks[0].source.chunkId]}))
});
const gate = () => {
  let resolve;
  const promise = new Promise(done => {resolve=done;});
  return {promise,resolve};
};
function fixture() {
  const f = createResearchFixture(api,'reading');
  const publish = (parseId = 'parse1', sourceHash = 'a'.repeat(64)) => {
    const input = {id:`card:${parseId}`,projectId:f.project.id,sourceType:'file',sourceId:'source.pdf',
      title:'Original source',content:`Original result ${parseId}.`,embeddingPolicy:'none',
      chunks:[{content:`Original result ${parseId}.`,locator:'PDF page 1',semantic:{
        paperId:'paper',parseId,sourceHash,blockId:'original-page',sectionPath:['Results'],
        semanticRole:'results',blockKind:'paragraph',relatedBlockIds:[]}}]};
    f.repository.knowledge.upsertFromSource(input,{fileId:'stable-document',parseId,sourceHash});
    f.repository.queueKnowledgeFromSource(input); f.repository.flushKnowledgeFromSource();
    return input.id;
  };
  return {...f,cards:f.repository.paperCards,wiki:f.repository.wiki,publish,
    row:() => f.db.prepare('SELECT * FROM research_paper_cards WHERE document_id=?').get('stable-document'),
    finish:async () => {await f.repository.paperCards.shutdown(); await f.repository.wiki.shutdown(); f.close();}};
}

test('legacy cards retain six sections and explicit missing IR while each derivation version regenerates unchanged source', async () => {
  const f = fixture();
  let config = {...cardsApi.paperCardDerivation,modelRevision:'selected-model-1'}, calls = 0;
  try {
    f.cards.start(async (_title,blocks) => {calls++; return result(blocks);}, {versions:() => config,pollMs:60_000});
    const id = f.publish(); await f.cards.idle(); await f.wiki.idle();
    assert.deepEqual(f.cards.fingerprint(id), {
      ...config,sourceHash:'a'.repeat(64),parseId:'parse1',paperIrHash:null,chunkVersion:'roc-paper-cl100k-2'
    });
    assert.equal(f.row().status,'ready');
    assert.equal(JSON.parse(f.row().snapshot_json).length,6);
    const page = (await f.wiki.search(f.project.id)).pages[0];
    const firstRevision = f.wiki.revision(f.project.id,page.id,page.revision);
    for (const delta of [{promptVersion:'prompt2'}, {modelRevision:'selected-model-2'},
      {extractorVersion:'extractor3'}, {outputSchemaVersion:2}]) {
      const previous = f.row();
      config = {...config,...delta};
      f.cards.wake(); await f.cards.idle(); await f.wiki.idle();
      assert.notEqual(f.row().generation,previous.generation);
      assert.notEqual(f.row().version,previous.version);
      assert.equal(f.row().status,'ready');
    }
    assert.equal(calls,5);
    assert.ok(f.wiki.history(f.project.id,page.id).length>=5);
    assert.deepEqual(f.wiki.revision(f.project.id,page.id,page.revision),firstRevision);
    assert.equal(f.repository.evidence.list(f.project.id).length,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_claims').pluck().get(),0);
  } finally {await f.finish();}
});

test('unchanged startup scans preserve Wiki history while source changes still invalidate it', async () => {
  const f = fixture();
  let recovered, calls = 0;
  const generate = async (_title, blocks) => {calls++; return result(blocks);};
  try {
    f.cards.start(generate, {pollMs:60_000});
    const id = f.publish(); await f.cards.idle(); await f.wiki.idle();
    const history = () => f.db.prepare('SELECT * FROM research_wiki_revisions ORDER BY rowid').all();
    const original = history();
    await f.cards.shutdown();
    recovered = new cardsApi.ResearchPaperCards(f.db,f.repository.knowledge,f.wiki);
    recovered.start(generate, {pollMs:60_000});
    await recovered.idle(); await f.wiki.idle();
    recovered.enqueue(id); recovered.wake(); await recovered.idle(); await f.wiki.idle();
    assert.equal(calls,1);
    assert.deepEqual(history(),original);
    await recovered.shutdown(); recovered = null;
    // A changed source must invalidate the retained reading even before inference succeeds.
    f.publish('parse2','b'.repeat(64)); await f.wiki.idle();
    const page = (await f.wiki.search(f.project.id)).pages[0];
    assert.ok(f.wiki.read(f.project.id,page.id).current.sections.some(s=>s.status==='stale'));
    assert.ok(history().length > original.length);
    assert.deepEqual(history().slice(0,original.length),original);
    const newProject = f.repository.createProject({title:'New membership',workspacePath:f.project.workspacePath+'/new-project',description:''});
    f.wiki.ensurePaperPage(newProject.id,'stable-document','Original source'); await f.wiki.idle();
    assert.equal((await f.wiki.search(newProject.id)).pages.length,1);
  } finally {await recovered?.shutdown(); await f.finish();}
});

test('a model change after inference without notification cannot publish the stale result', async () => {
  const f = fixture(), started = gate(), release = gate(), freshStarted = gate(), releaseFresh = gate();
  let revision = 'model1', calls = 0;
  try {
    f.cards.start(async (_title,blocks) => {
      calls++;
      if (calls === 2) {started.resolve(); await release.promise; return result(blocks,'Stale model output.');}
      if (calls === 3) {freshStarted.resolve(); await releaseFresh.promise;}
      return result(blocks,calls === 1 ? 'Retained original reading.' : 'Fresh model output.');
    }, {versions:() => ({...cardsApi.paperCardDerivation,modelRevision:revision}),pollMs:60_000});
    f.publish(); await f.cards.idle(); await f.wiki.idle();
    const previous = f.row(), page = (await f.wiki.search(f.project.id)).pages[0];
    const original = f.wiki.revision(f.project.id,page.id,page.revision);
    f.cards.retry(f.project.id,page.id); await started.promise;
    revision = 'model2'; release.resolve(); await freshStarted.promise;
    assert.equal(f.row().snapshot_json,previous.snapshot_json);
    assert.equal(f.row().status,'running');
    assert.deepEqual(f.wiki.revision(f.project.id,page.id,page.revision),original);
    releaseFresh.resolve(); await f.cards.idle(); await f.wiki.idle();
    assert.equal(f.row().status,'ready');
    assert.match(f.row().snapshot_json,/Fresh model output/);
    assert.doesNotMatch(f.row().snapshot_json,/Stale model output/);
    for (const entry of f.wiki.history(f.project.id,page.id)) {
      assert.doesNotMatch(JSON.stringify(f.wiki.revision(f.project.id,page.id,entry.revision)),/Stale model output/);
    }
  } finally {release.resolve(); releaseFresh.resolve(); await f.finish();}
});

test('superseded running jobs cannot overwrite a newer generation and reparses retain historical Wiki references', async () => {
  const f = fixture(), started = gate(), release = gate();
  let calls = 0, revision = 'model1';
  try {
    f.cards.start(async (_title,blocks) => {
      calls++;
      if (calls === 2) {started.resolve(); await release.promise;}
      return result(blocks,`Reading call ${calls}.`);
    }, {versions:() => ({...cardsApi.paperCardDerivation,modelRevision:revision}),pollMs:60_000});
    f.publish(); await f.cards.idle(); await f.wiki.idle();
    const page = (await f.wiki.search(f.project.id)).pages[0], original = f.wiki.revision(f.project.id,page.id,page.revision);
    f.cards.retry(f.project.id,page.id); await started.promise;
    const obsoleteGeneration = f.row().generation;
    revision = 'model2'; f.publish('parse2','b'.repeat(64));
    assert.notEqual(f.row().generation,obsoleteGeneration);
    release.resolve(); await f.cards.idle(); await f.wiki.idle();
    assert.equal(f.row().status,'ready');
    assert.match(f.row().snapshot_json,/Reading call 3/);
    assert.doesNotMatch(f.row().snapshot_json,/Reading call 2/);
    assert.equal(f.wiki.read(f.project.id,page.id).current.sections[0].paperSources[0].parseId,'parse2');
    assert.deepEqual(f.wiki.revision(f.project.id,page.id,page.revision),original);
  } finally {release.resolve(); await f.finish();}
});

test('failed unchanged inputs stay failed across scans and restart; explicit retry preserves old prose', async () => {
  const f = fixture();
  let fail = false, calls = 0;
  const generate = async (_title,blocks) => {calls++; if (fail) throw new Error('private provider detail'); return result(blocks);};
  try {
    f.cards.start(generate,{pollMs:60_000}); const id = f.publish();
    await f.cards.idle(); await f.wiki.idle();
    const snapshot = f.row().snapshot_json, page = (await f.wiki.search(f.project.id)).pages[0];
    fail = true; f.cards.retry(f.project.id,page.id); await f.cards.idle();
    const failedGeneration = f.row().generation;
    assert.equal(f.row().status,'failed'); assert.doesNotMatch(f.row().error,/private/);
    f.cards.enqueue(id); f.cards.wake(); await f.cards.idle();
    f.cards.start(generate,{pollMs:60_000}); await f.cards.idle();
    assert.equal(f.row().generation,failedGeneration); assert.equal(calls,2);
    assert.equal(f.row().snapshot_json,snapshot);
    fail = false; f.cards.retry(f.project.id,page.id); await f.cards.idle(); await f.wiki.idle();
    assert.notEqual(f.row().generation,failedGeneration); assert.equal(f.row().status,'ready');
    assert.equal(calls,3);
  } finally {await f.finish();}
});

test('restart recovers a running same-input generation; source removal fails visibly without deleting the retained snapshot', async () => {
  const f = fixture(), started = gate(), release = gate();
  let recovered;
  try {
    f.cards.start(async (_title,blocks) => result(blocks),{pollMs:60_000});
    const id = f.publish(); await f.cards.idle(); await f.wiki.idle();
    const previous = f.row();
    await f.cards.shutdown();
    f.db.prepare("UPDATE research_paper_cards SET status='running' WHERE document_id=?").run('stable-document');
    recovered = new cardsApi.ResearchPaperCards(f.db,f.repository.knowledge,f.wiki);
    recovered.start(async (_title,blocks) => {started.resolve(); await release.promise; return result(blocks);}, {pollMs:60_000});
    await started.promise;
    assert.equal(f.row().generation,previous.generation);
    f.db.prepare('DELETE FROM research_knowledge_documents WHERE id=?').run(id);
    release.resolve(); await recovered.idle();
    assert.equal(f.row().snapshot_json,previous.snapshot_json);
    assert.equal(f.row().status,'failed');
  } finally {release.resolve(); await recovered?.shutdown(); await f.finish();}
});

test('published original PDF IR binds by knowledge identity, ignores embedding-only generations and changes on reparse', async () => {
  const f = await scientificSearchFixture(scientificApi,{embedded:false});
  const cards = f.repository.paperCards, wiki = f.repository.wiki;
  let calls = 0;
  try {
    cards.start(async (_title,blocks) => {calls++; return result(blocks);},{pollMs:60_000});
    await cards.idle(); await wiki.idle();
    const id = f.ir.identity.knowledgeDocumentId;
    assert.notEqual(id,f.document.id);
    const fingerprint = cards.fingerprint(id);
    assert.equal(fingerprint.paperIrHash,f.data.paperIR.sha256);
    assert.equal(fingerprint.sourceHash,f.document.sourceHash);
    const row = () => f.db.prepare('SELECT * FROM research_paper_cards WHERE document_id=?').get(f.document.id);
    const initial = row(), originalPage = (await wiki.search(f.project.id)).pages[0];
    const originalRevision = wiki.revision(f.project.id,originalPage.id,originalPage.revision);
    const generation = f.repository.scientificIndex.begin({ir:f.ir,paperIR:f.data.paperIR,projectId:null,
      source:{kind:'library'},embedding:null,policy:{tableTokens:64}});
    f.repository.scientificIndex.publish(generation.id,() => ({paperIR:f.data.paperIR,embedding:null}));
    cards.enqueue(id); cards.wake(); await cards.idle();
    assert.equal(row().generation,initial.generation); assert.equal(calls,1);
    const parsed = await f.publish(); await cards.idle(); await wiki.idle();
    assert.notEqual(cards.fingerprint(parsed.ir.identity.knowledgeDocumentId).paperIrHash,fingerprint.paperIrHash);
    assert.equal(row().status,'ready'); assert.equal(calls,2);
    assert.deepEqual(wiki.revision(f.project.id,originalPage.id,originalPage.revision),originalRevision);
    const metadata = f.db.prepare('SELECT metadata_json FROM research_knowledge_documents WHERE id=?').pluck()
      .get(parsed.ir.identity.knowledgeDocumentId);
    f.db.prepare('UPDATE research_knowledge_documents SET metadata_json=? WHERE id=?')
      .run(JSON.stringify({...JSON.parse(metadata),sourceHash:'f'.repeat(64)}),parsed.ir.identity.knowledgeDocumentId);
    assert.throws(() => cards.fingerprint(parsed.ir.identity.knowledgeDocumentId),/wiki_paper_ir_changed/);
  } finally {await cards.shutdown(); await wiki.shutdown(); await f.close();}
});
