import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, services;
before(async () => {
  [api, services] = await Promise.all([
    loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-extraction-service.ts',
      {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'})
  ]);
});
after(() => api?.dispose());
const request = (f, generationId = null) => ({projectId: f.project.id, documentId: f.document.id, generationId});
const roles = ['problem', 'contribution', 'method', 'experimental_setup', 'results', 'limitations'];
function candidates(ir) {
  const table = ir.tables[0], cell = text => {
    const c = table.cells.find(value => value.text === text);
    return {kind: 'table_cell', tableId: table.id, cellId: c.id, raw: c.text};
  };
  const unknown = {datasetId: null, datasetVersion: 'unknown', split: 'unknown', metricId: null,
    baselineId: null, budget: 'unknown', other: {}};
  return {
    entities: [
      {id: 'method', entityType: 'Method', canonicalName: 'Original baseline', aliases: [],
        attributes: {description: null}, evidence: [cell('Original baseline')]},
      {id: 'metric', entityType: 'Metric', canonicalName: 'F1', aliases: [],
        attributes: {definition: null, direction: 'unknown', unit: '%'}, evidence: [cell('F1 (%)')]},
      {id: 'experiment', entityType: 'Experiment', canonicalName: 'Original baseline', aliases: [],
        attributes: {configuration: null, conditions: {}}, evidence: [cell('Original baseline')]}
    ],
    facts: [
      {id: 'result', factType: 'experimental_result', subjectEntityId: 'method', predicate: 'Reported F1',
        objectEntityId: null, value: {raw: '90', unit: null, unitEvidence: []},
        conditions: {...unknown, metricId: 'metric'},
        conditionEvidence: [{field: 'metricId', key: null, evidence: [cell('F1 (%)')]}],
        table: {tableId: table.id, row: 1, cellId: cell('90').cellId},
        evidence: [cell('90'), cell('Original baseline')], confidence: .8},
      {id: 'component', factType: 'method_component', subjectEntityId: 'method', predicate: 'Original baseline',
        objectEntityId: null, value: null, conditions: unknown, conditionEvidence: [], table: null,
        evidence: [cell('Original baseline')], confidence: .8}
    ],
    relations: [{id: 'evaluates', type: 'EVALUATES_WITH', fromEntityId: 'experiment', toEntityId: 'metric',
      factIds: ['result'], evidence: [cell('Original baseline'), cell('F1 (%)')]}]
  };
}
async function setup({configured = true} = {}) {
  const f = await scientificSearchFixture(api, {embedded: false, image: true});
  let selected = 'selected-model/1', handle = 'handle-revision/1', prompt = 'prompt/1', unavailable = false;
  f.service = new services.ScientificExtractionService(f.repository, {library: f.root, index: null}, async () => {
    if (unavailable) throw new Error('private credential detail');
    return {config: {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: prompt,
      model: {provider: 'fixture', modelId: 'fixture-model', model: 'fixture-model', revision: handle},
      inputTokens: 16_000, batchTokens: 8000}, invoke: async () => {throw new Error('no model inference in a read');}};
  }, () => selected, {pollMs: 60_000});
  if (configured) f.repository.paperCards.configureKnowledge((input, signal) => f.service.readPaperCard(input, signal));
  f.switchModel = () => {selected = 'selected-model/2'; handle = 'handle-revision/2';};
  f.switchPrompt = () => {selected = 'selected-prompt/2'; prompt = 'prompt/2';};
  f.unavailable = () => {selected = 'selected-unavailable'; unavailable = true;};
  f.publishKnowledge = async ir => {
    const job = await f.service.enqueue(request(f));
    f.repository.scientificExtraction.claim(job.id, f.project.id);
    return f.repository.scientificExtraction.publish(job.id, f.project.id, candidates(ir), ir, () => job.snapshot);
  };
  f.read = generationId => f.repository.paperCards.readKnowledge(request(f, generationId ?? null));
  f.finish = async () => {
    await f.service.shutdown(); await f.repository.paperCards.shutdown();
    await f.repository.wiki.shutdown(); await f.close();
  };
  return f;
}

test('Paper Card v2 reads independent saved knowledge and complete original objects while retaining six reading sections', async () => {
  const f = await setup();
  try {
    f.repository.paperCards.start(async (_title, blocks) => ({sections: roles.map(role =>
      ({role, body: 'Unreviewed original reading.', chunkIds: [blocks[0].source.chunkId]}))}), {pollMs: 60_000});
    await f.repository.paperCards.idle(); await f.repository.wiki.idle();
    const before = f.db.prepare('SELECT snapshot_json FROM research_paper_cards').pluck().get();
    const job = await f.publishKnowledge(f.ir), serialized = f.db.serialize();
    const card = await f.read();
    assert.equal(card.version, 2); assert.equal(card.state, 'current'); assert.equal(card.publishedJob.id, job.id);
    assert.equal(card.paperIR.sha256, f.data.paperIR.sha256);
    assert.deepEqual(card.objects, {tables: f.ir.tables, figures: f.ir.figures, equations: f.ir.equations, algorithms: f.ir.algorithms});
    assert.equal(card.objects.tables[0].cells.find(c => c.text === '90').sourceLocator.objectId,
      card.knowledge.facts[0].evidence[0].locator.objectId);
    assert.equal(card.knowledge.facts[0].value.raw, '90'); assert.equal(card.knowledge.facts[0].value.normalized, '0.9');
    assert.equal(card.knowledge.facts[0].conditions.split, 'unknown');
    assert.deepEqual(card.methodComponentIds, [card.knowledge.facts.find(fact => fact.factType === 'method_component').id]);
    assert.ok(card.knowledge.relations.every(relation => relation.scientificApproval === 'unreviewed'));
    assert.equal(f.db.prepare('SELECT snapshot_json FROM research_paper_cards').pluck().get(), before);
    assert.equal(JSON.parse(before).length, 6);
    assert.deepEqual(f.db.serialize(), serialized, 'structured reads never rewrite durable knowledge or revisions');
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_claims').pluck().get(), 0);
  } finally {await f.finish();}
});

test('missing extraction is explicit and retains the current original IR receipt', async () => {
  const f = await setup();
  try {
    const card = await f.read();
    assert.equal(card.state, 'missing'); assert.equal(card.currentPaperIR.sha256, f.data.paperIR.sha256);
    assert.equal(card.knowledge, null); assert.equal(card.objects, null); assert.equal(card.paperIR, null);
    assert.deepEqual(card.methodComponentIds, []);
  } finally {await f.finish();}
});

test('model and prompt changes mark retained facts stale without a notification or identity substitution', async () => {
  const f = await setup();
  try {
    const job = await f.publishKnowledge(f.ir), original = f.repository.scientificExtraction.bundle(job.id, f.project.id);
    assert.equal((await f.read()).state, 'current');
    assert.notEqual(job.snapshot.config.model.revision, 'selected-model/1');
    f.switchModel();
    assert.equal((await f.read()).state, 'stale');
    const modelJob = await f.publishKnowledge(f.ir);
    assert.equal((await f.read()).publishedJob.id, modelJob.id); assert.equal((await f.read()).state, 'current');
    f.switchPrompt();
    const changed = await f.read();
    assert.equal(changed.state, 'stale'); assert.ok(changed.knowledge.facts.every(fact => fact.status === 'stale'));
    assert.deepEqual(f.repository.scientificExtraction.bundle(job.id, f.project.id), original);
    f.unavailable();
    const unavailable = await f.read();
    assert.equal(unavailable.state, 'stale'); assert.ok(unavailable.configurationError);
    assert.doesNotMatch(unavailable.configurationError, /private|credential/);
    assert.deepEqual(unavailable.objects.tables, f.ir.tables);
  } finally {await f.finish();}
});

test('reparse keeps historical object bytes and evidence identities separate from the new current IR', async () => {
  const f = await setup();
  try {
    const old = await f.publishKnowledge(f.ir), original = await f.read();
    const parsed = await f.publish(), stale = await f.read();
    assert.equal(stale.state, 'stale'); assert.equal(stale.currentPaperIR.sha256, parsed.data.paperIR.sha256);
    assert.equal(stale.paperIR.sha256, original.paperIR.sha256); assert.deepEqual(stale.objects, original.objects);
    assert.ok(stale.knowledge.facts.every(fact => fact.evidence.every(source => source.identity.parseId === f.ir.identity.parseId)));
    const next = await f.publishKnowledge(parsed.ir), current = await f.read(), history = await f.read(old.id);
    assert.equal(current.state, 'current'); assert.equal(current.publishedJob.id, next.id);
    assert.equal(history.state, 'stale'); assert.equal(history.publishedJob.id, old.id);
    assert.deepEqual(history.objects, original.objects);
    assert.deepEqual(f.repository.scientificExtraction.bundle(old.id, f.project.id),
      {...original.knowledge});
  } finally {await f.finish();}
});

test('structured capability uses the real IPC contract and reauthorizes history against project membership', async () => {
  const f = await setup();
  try {
    await f.publishKnowledge(f.ir);
    const registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchWikiCapabilities) registry.declare('research', descriptor);
    api.registerResearchWikiCapabilities({pluginId: 'research', capabilities: registry}, f.repository.wiki, f.repository.paperCards);
    const adapter = api.createPluginCapabilityAdapter({invokeCapability: (...args) => registry.invoke(...args)});
    const response = await adapter.invoke('research.readWikiPaperKnowledge', [request(f)], 42);
    assert.equal(response.ok, true); assert.equal(response.data.state, 'current');
    const other = f.repository.createProject({title: 'Other', description: '', workspacePath: '/tmp/card-other'});
    await assert.rejects(() => f.repository.paperCards.readKnowledge({...request(f), projectId: other.id}), /scope_invalid/);
    const malformed = await adapter.invoke('research.readWikiPaperKnowledge', [{...request(f), path: '/private'}], 42);
    assert.equal(malformed.ok, false);
    f.db.prepare('DELETE FROM research_library_projects WHERE item_id=? AND project_id=?').run(f.document.libraryItemId, f.project.id);
    await assert.rejects(() => f.read(response.data.publishedJob.id), /scope_invalid/);
  } finally {await f.finish();}
});

test('original PDF and immutable IR tampering fail before exposing current scientific objects', async () => {
  const f = await setup();
  try {
    const job = await f.publishKnowledge(f.ir), path = join(f.root, job.snapshot.source.paperIR.path);
    await writeFile(path, JSON.stringify({...f.ir, metadata: {...f.ir.metadata, title: 'Tampered'}}));
    await assert.rejects(() => f.read(), /artifact_changed/);
    await writeFile(path, JSON.stringify(f.ir));
    await writeFile(f.source, Buffer.alloc(f.bytes.length, 1));
    await assert.rejects(() => f.read(), /source_.*(?:changed|invalid|conflict)/);
    assert.equal(f.repository.scientificExtraction.active(f.project.id, f.document.id).id, job.id);
  } finally {await f.finish();}
});

test('unconfigured and cancelled Paper Card reads fail explicitly', async () => {
  const f = await setup({configured: false});
  try {
    await assert.rejects(() => f.read(), /wiki_scientific_knowledge_unavailable/);
    f.repository.paperCards.configureKnowledge((input, signal) => f.service.readPaperCard(input, signal));
    const controller = new AbortController(); controller.abort(new Error('read_cancelled'));
    await assert.rejects(() => f.repository.paperCards.readKnowledge(request(f), controller.signal), /read_cancelled/);
    await f.repository.paperCards.shutdown();
    await assert.rejects(() => f.read(), /abort/i);
  } finally {await f.finish();}
});
