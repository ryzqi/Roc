import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, services;
before(async () => {
  [api, services] = await Promise.all([loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-extraction-service.ts',
      {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'})]);
});
after(() => api?.dispose());
const proposal = ir => {
  const table = ir.tables[0], cell = table.cells.find(c => c.text === 'Original baseline');
  const evidence = [{kind: 'table_cell', tableId: table.id, cellId: cell.id, raw: cell.text}];
  return {
    entities: [{id: 'method', entityType: 'Method', canonicalName: cell.text, aliases: [],
      attributes: {description: null}, evidence}],
    facts: [{id: 'component', factType: 'method_component', subjectEntityId: 'method',
      predicate: cell.text, objectEntityId: null, value: null, conditions: {
        datasetId: null, datasetVersion: 'unknown', split: 'unknown', metricId: null,
        baselineId: null, budget: 'unknown', other: {}
      }, conditionEvidence: [], table: null, evidence, confidence: .8}],
    relations: []
  };
};
const source = (f, job) => ({documentId: f.document.id, generationId: job.id});
const input = (f, page, id, body) => ({
  projectId: f.project.id, pageId: page.page.id, expectedRevision: page.page.revision,
  expectedBasisDigest: page.basisDigest, section: {id, title: id, body,
    evidenceIds: [], claimIds: [], links: [], paperKnowledgeSources: page.current.sections[0].paperKnowledgeSources}
});
async function setup() {
  const f = await scientificSearchFixture(api, {embedded: false});
  let stamp = 'selected-model/1', revision = 'handle-revision/1', prompt = 'prompt/1', unavailable = false;
  f.service = new services.ScientificExtractionService(f.repository, {library: f.root, index: null}, async () => {
    if (unavailable) throw new Error('fixture-model-unavailable');
    return {config: {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: prompt,
      model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision},
      inputTokens: 16000, batchTokens: 8000}, invoke: async () => {throw new Error('no inference in a dependency read');}};
  }, () => stamp, {pollMs: 60000});
  f.wiki = f.repository.wiki;
  f.wiki.configureKnowledge({
    state: (projectId, documentId) => f.service.wikiKnowledgeState(projectId, documentId),
    read: (projectId, ref, signal) => f.service.readPaperCard({...ref, projectId}, signal)
  });
  f.switchModel = () => {stamp = 'selected-model/2'; revision = 'handle-revision/2';};
  f.switchPrompt = () => {stamp = 'selected-prompt/2'; prompt = 'prompt/2';};
  f.unavailable = () => {stamp = 'selected-unavailable'; unavailable = true;};
  f.publishKnowledge = async (ir = f.ir, projectId = f.project.id, force = false) => {
    let job = await f.service.enqueue({projectId, documentId: f.document.id});
    if (force) job = f.repository.scientificExtraction.enqueue(job.snapshot, ir, true);
    f.repository.scientificExtraction.claim(job.id, projectId);
    return f.repository.scientificExtraction.publish(job.id, projectId, proposal(ir), ir, () => job.snapshot);
  };
  f.createPage = async (job, projectId = f.project.id) => {
    const created = await f.wiki.createCurrent({projectId, title: 'Scientific topic', kind: 'topic',
      evidenceIds: [], claimIds: [], paperKnowledgeSources: [source(f, job)]});
    await f.wiki.idle();
    return await f.wiki.readCurrent(projectId, created.page.id);
  };
  f.finish = async () => {
    await f.service.shutdown(); await f.repository.paperCards.shutdown(); await f.wiki.shutdown(); await f.close();
  };
  return f;
}

test('current scientific selection creates a source-bound section and one aggregate dependency without changing old page kinds', async () => {
  const f = await setup();
  try {
    const job = await f.publishKnowledge(), page = await f.createPage(job), section = page.current.sections[0];
    assert.equal(page.page.kind, 'topic'); assert.equal(section.status, 'current');
    assert.deepEqual(section.paperKnowledgeSources, [source(f, job)]);
    assert.deepEqual(section.dependencies, [{
      kind: 'paper_knowledge', id: f.document.id, digest: f.service.wikiKnowledgeState(f.project.id, f.document.id).digest
    }]);
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_wiki_dependencies WHERE page_id=? AND kind='paper_knowledge'")
      .pluck().get(page.page.id), 1);
    assert.notEqual(job.snapshot.config.model.revision, 'selected-model/1');
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_claims').pluck().get(), 0);
    const before = f.db.serialize();
    const read = await f.wiki.readCurrent(f.project.id, page.page.id);
    assert.equal(read.basisDigest, page.basisDigest); assert.deepEqual(f.db.serialize(), before);
  } finally {await f.finish();}
});

test('model/prompt changes invalidate basis before notification and enqueue only once for the same stale basis', async () => {
  const f = await setup();
  try {
    const job = await f.publishKnowledge(), page = await f.createPage(job);
    f.switchModel();
    assert.equal(f.service.wikiKnowledgeState(f.project.id, f.document.id).state, 'unavailable');
    const stale = f.wiki.read(f.project.id, page.page.id);
    assert.equal(stale.current.sections[0].status, 'stale'); assert.notEqual(stale.basisDigest, page.basisDigest);
    assert.throws(() => f.wiki.save(input(f, page, 'synthesis', 'Old model interpretation.'), 'assistant'), /basis_changed/);
    f.wiki.refreshPaperKnowledgeDependencies();
    const first = f.wiki.read(f.project.id, page.page.id).page.job.generation;
    f.wiki.refreshPaperKnowledgeDependencies();
    assert.equal(f.wiki.read(f.project.id, page.page.id).page.job.generation, first);
    await f.wiki.idle();
    const compiled = f.wiki.read(f.project.id, page.page.id);
    f.wiki.refreshPaperKnowledgeDependencies(); await f.wiki.idle();
    assert.equal(f.wiki.read(f.project.id, page.page.id).page.revision, compiled.page.revision);
    const next = await f.publishKnowledge();
    assert.equal(f.service.wikiKnowledgeState(f.project.id, f.document.id).state, 'current');
    assert.equal(f.service.wikiKnowledgeState(f.project.id, f.document.id).generationId, next.id);
    await f.wiki.idle();
    const refreshed = await f.wiki.readCurrent(f.project.id, page.page.id);
    assert.equal(refreshed.page.job.status, 'ready');
    assert.equal(refreshed.current.sections[0].paperKnowledgeSources[0].generationId, next.id);
    assert.equal(refreshed.current.sections[0].status, 'current');
    f.switchPrompt();
    assert.equal((await f.wiki.readCurrent(f.project.id, page.page.id)).current.sections[0].status, 'stale');
  } finally {await f.finish();}
});

test('republication changes the digest while preserving old assistant/human prose, dependencies and exact revision bytes', async () => {
  const f = await setup();
  try {
    const first = await f.publishKnowledge();
    let page = await f.createPage(first);
    page = await f.wiki.saveCurrent(input(f, page, 'assistant', 'Source-bound assistant interpretation.'), 'assistant');
    page = api.withResearchHumanContext({capability: 'research.wiki.save', projectId: f.project.id, windowId: 42},
      () => f.wiki.save(input(f, page, 'human', 'Human maintained scientific note.'), 'human'));
    const old = page.current, bytes = f.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?')
      .pluck().get(page.page.id, old.revision);
    const next = await f.publishKnowledge(f.ir, f.project.id, true);
    await f.wiki.idle();
    const current = await f.wiki.readCurrent(f.project.id, page.page.id);
    assert.notEqual(next.id, first.id);
    assert.equal(current.current.sections.find(s => s.owner === 'system').paperKnowledgeSources[0].generationId, next.id);
    for (const owner of ['assistant', 'human']) {
      const retained = current.current.sections.find(s => s.owner === owner), prior = old.sections.find(s => s.owner === owner);
      assert.equal(retained.body, prior.body); assert.deepEqual(retained.dependencies, prior.dependencies);
      assert.deepEqual(retained.paperKnowledgeSources, prior.paperKnowledgeSources); assert.equal(retained.status, 'stale');
    }
    assert.equal(f.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?')
      .pluck().get(page.page.id, old.revision), bytes);
    assert.deepEqual(f.wiki.revision(f.project.id, page.page.id, old.revision), old);
    const human = current.current.sections.find(s => s.owner === 'human');
    await assert.rejects(() => f.wiki.saveCurrent({...input(f, current, human.id, 'Overwrite'), section: {
      ...input(f, current, human.id, 'Overwrite').section, paperKnowledgeSources: current.current.sections[0].paperKnowledgeSources
    }}, 'assistant'), /human_section_protected/);
  } finally {await f.finish();}
});

test('explicit alias revisions invalidate only the owning project and retain the old dictionary/result snapshots', async () => {
  const f = await setup();
  try {
    const first = await f.publishKnowledge(), page = await f.createPage(first);
    const other = f.repository.createProject({title: 'Other project', description: '', workspacePath: '/tmp/wiki-knowledge-other'});
    f.db.prepare('INSERT INTO research_library_projects(item_id,project_id) VALUES (?,?)').run(f.document.libraryItemId, other.id);
    const otherJob = await f.publishKnowledge(f.ir, other.id), otherPage = await f.createPage(otherJob, other.id);
    const original = f.repository.scientificExtraction.bundle(first.id, f.project.id), target = original.entities[0];
    f.repository.scientificExtraction.putAlias({id: 'fixture-alias', projectId: f.project.id, entityType: target.entityType,
      alias: target.canonicalName, targetEntityId: target.id, canonicalName: target.canonicalName, revision: 1, createdBy: 'fixture-human'}, target);
    assert.equal(f.wiki.read(f.project.id, page.page.id).page.job.status, 'queued');
    await f.wiki.idle(); f.wiki.refreshPaperKnowledgeDependencies(); await f.wiki.idle();
    assert.equal(f.wiki.read(other.id, otherPage.page.id).page.revision, otherPage.page.revision);
    assert.equal(f.wiki.read(other.id, otherPage.page.id).current.sections[0].status, 'current');
    assert.equal(f.wiki.read(f.project.id, page.page.id).current.sections[0].status, 'stale');
    assert.deepEqual(f.repository.scientificExtraction.get(first.id, f.project.id).snapshot.resolution.aliases, []);
    assert.deepEqual(f.repository.scientificExtraction.bundle(first.id, f.project.id), original);
  } finally {await f.finish();}
});

test('reparse, original PDF tampering and IR tampering cannot expose current Wiki knowledge', async () => {
  const f = await setup();
  try {
    const job = await f.publishKnowledge(), page = await f.createPage(job);
    await writeFile(f.source, Buffer.from(f.bytes).fill(0));
    const tampered = await f.wiki.readCurrent(f.project.id, page.page.id);
    assert.equal(tampered.current.sections[0].status, 'stale');
    assert.ok(tampered.lint.some(issue => issue.code === 'missing'));
    await assert.rejects(() => f.wiki.createCurrent({projectId: f.project.id, title: 'Tampered', kind: 'topic',
      evidenceIds: [], claimIds: [], paperKnowledgeSources: [source(f, job)]}), /source_changed/);
    await writeFile(f.source, f.bytes);
    const path = join(f.root, job.snapshot.source.paperIR.path);
    await writeFile(path, JSON.stringify({...f.ir, metadata: {...f.ir.metadata, title: 'Tampered'}}));
    assert.equal((await f.wiki.readCurrent(f.project.id, page.page.id)).current.sections[0].status, 'stale');
    await writeFile(path, JSON.stringify(f.ir));
    assert.equal((await f.wiki.readCurrent(f.project.id, page.page.id)).current.sections[0].status, 'current');
    const nextParse = await f.publish();
    assert.equal(f.service.wikiKnowledgeState(f.project.id, f.document.id).state, 'stale');
    f.wiki.refreshPaperKnowledgeDependencies(); await f.wiki.idle();
    const reparsed = await f.wiki.readCurrent(f.project.id, page.page.id);
    assert.equal(reparsed.current.sections[0].status, 'stale');
    assert.equal(reparsed.current.sections[0].paperKnowledgeSources[0].generationId, job.id);
    assert.notEqual(nextParse.ir.identity.parseId, f.ir.identity.parseId);
  } finally {await f.finish();}
});

test('transaction rollback cannot suppress the next notification and cannot publish a revision or extraction result', async () => {
  const f = await setup();
  try {
    const first = await f.publishKnowledge(), page = await f.createPage(first);
    f.switchModel();
    const oldJob = f.wiki.read(f.project.id, page.page.id).page.job.generation;
    assert.throws(() => f.db.transaction(() => {
      f.wiki.refreshPaperKnowledgeDependencies();
      throw new Error('deliberate rollback');
    })(), /deliberate rollback/);
    assert.equal(f.wiki.read(f.project.id, page.page.id).page.job.generation, oldJob);
    f.wiki.refreshPaperKnowledgeDependencies();
    assert.notEqual(f.wiki.read(f.project.id, page.page.id).page.job.generation, oldJob);
    await f.wiki.idle();
    let job = await f.service.enqueue({projectId: f.project.id, documentId: f.document.id});
    f.repository.scientificExtraction.claim(job.id, f.project.id);
    const count = f.wiki.history(f.project.id, page.page.id).length;
    assert.throws(() => f.repository.scientificExtraction.publish(job.id, f.project.id, proposal(f.ir), f.ir,
      () => job.snapshot, () => Promise.resolve()), /must_be_synchronous/);
    await f.wiki.idle();
    assert.equal(f.repository.scientificExtraction.active(f.project.id, f.document.id).id, first.id);
    assert.equal(f.wiki.history(f.project.id, page.page.id).length, count);
  } finally {await f.finish();}
});

test('real Wiki IPC carries scientific references, fails closed on source scope and reads old revisions without adding fields', async () => {
  const f = await setup();
  try {
    const job = await f.publishKnowledge(), registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchWikiCapabilities) registry.declare('research', descriptor);
    api.registerResearchWikiCapabilities({pluginId: 'research', capabilities: registry}, f.wiki, f.repository.paperCards);
    const adapter = api.createPluginCapabilityAdapter({invokeCapability: (...args) => registry.invoke(...args)});
    const created = await adapter.invoke('research.createWiki', [{
      projectId: f.project.id, title: 'IPC topic', kind: 'topic', evidenceIds: [], claimIds: [],
      paperKnowledgeSources: [source(f, job)]
    }], 42);
    assert.equal(created.ok, true); await f.wiki.idle();
    const read = await adapter.invoke('research.readWiki', [{projectId: f.project.id, pageId: created.data.page.id}], 42);
    assert.equal(read.ok, true); assert.equal(read.data.current.sections[0].status, 'current');
    f.unavailable();
    const stale = await adapter.invoke('research.readWiki', [{projectId: f.project.id, pageId: created.data.page.id}], 42);
    assert.equal(stale.ok, true); assert.equal(stale.data.current.sections[0].status, 'stale');
    const other = f.repository.createProject({title: 'No membership', description: '', workspacePath: '/tmp/wiki-denied'});
    await assert.rejects(() => f.wiki.createCurrent({projectId: other.id, title: 'Wrong project', kind: 'comparison',
      evidenceIds: [], claimIds: [], paperKnowledgeSources: [source(f, job)]}), /scope_invalid/);
    const old = {pageId: read.data.page.id, revision: 99, createdAt: 'historical', reason: 'compile', sections: [{
      id: 'old', title: 'Historical', body: 'Historical prose', evidenceIds: [], claimIds: [], links: [],
      owner: 'system', status: 'current', dependencies: []
    }]};
    f.db.prepare('INSERT INTO research_wiki_revisions VALUES (?,?,?)').run(old.pageId, old.revision, JSON.stringify(old));
    assert.deepEqual(f.wiki.revision(f.project.id, old.pageId, old.revision), old);
  } finally {await f.finish();}
});
