import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let LiteratureWikiAcquisition, reconcileAcquisitionReadiness;
before(async () => {
  ({LiteratureWikiAcquisition, reconcileAcquisitionReadiness} = await importTypeScriptModule(
    'src/main/plugins/research/literature-wiki-acquisition.ts', {platform: 'node'}));
});

const instant = Date.parse('2026-11-19T08:00:00.000Z');
const job = (overrides = {}) => ({id: 'acq-1', generation: 'generation-1', projectId: 'project-1',
  libraryItemId: 'item-1', title: 'Original paper', stage: 'wiki', status: 'running', attempts: 0,
  nextRetryAt: null, documentId: 'doc-1', source: null, receipt: {sha256: 'a'.repeat(64)}, errorCode: null,
  updatedAt: new Date(instant).toISOString(), ...overrides});
const source = (overrides = {}) => ({documentId: 'doc-1', pageId: 'paper-page-1', revision: 2,
  ready: true, status: 'ready', publication: 'wiki_page', generation: 'card-generation-1', error: null, ...overrides});
const batch = (overrides = {}) => ({operationId: 'operation-1', title: 'Operation topic', total: 10,
  documentIds: ['doc-1', 'doc-pending', 'doc-failed'], ...overrides});
const topic = (overrides = {}) => ({pageId: 'topic-page-1', revision: 3, ready: true, status: 'partial',
  coverage: {total: 10, readySources: 1, covered: 1, missing: 9, complete: false},
  sources: [source()], error: null, ...overrides});

function pipelineFixture({current = source(), operations = [batch()], topics = [topic()], onEnsure,
  onRetry, onBatch, retryResult = source({ready: false, status: 'pending'})} = {}) {
  const calls = [];
  let batchIndex = 0;
  const wiki = {
    ensureSource(projectId, documentId) {calls.push(['ensure', projectId, documentId]); onEnsure?.(); return current;},
    readSource(projectId, documentId) {calls.push(['read', projectId, documentId]); return current;},
    retrySource(projectId, documentId) {calls.push(['retry', projectId, documentId]); onRetry?.(); return retryResult;},
    reconcileBatch(input) {calls.push(['topic', structuredClone(input)]); onBatch?.(input); return topics[batchIndex++];}
  };
  const acquisitions = {wikiBatches(claim) {calls.push(['batches', claim]); return operations;}};
  const pipeline = new LiteratureWikiAcquisition(wiki, acquisitions, () => instant);
  return {calls, pipeline, run: (claim = job(), signal = new AbortController().signal, requireCurrent = () => {}) =>
    pipeline.process(claim, signal, requireCurrent)};
}

function queued(outcome, errorCode) {
  assert.equal(outcome.stage, 'wiki');
  assert.equal(outcome.status, 'queued');
  assert.equal(outcome.nextRetryAt, new Date(instant + 1000).toISOString());
  assert.equal(outcome.errorCode, errorCode);
}

test('only a verified source and every operation Topic permit ready; partial coverage is usable', async () => {
  const operations = [batch(), batch({operationId: 'operation-2', title: 'Second operation', total: 2,
    documentIds: ['doc-foreign-to-first', 'doc-1']})];
  const f = pipelineFixture({operations, topics: [topic(), topic({status: 'ready',
    coverage: {total: 2, readySources: 2, covered: 2, missing: 0, complete: true}})]});
  const claim = job();
  assert.deepEqual(await f.run(claim), {stage: 'wiki', status: 'ready', documentId: claim.documentId});
  assert.deepEqual(f.calls.filter(([name]) => name === 'topic').map(([, input]) => input), operations.map(operation => ({
    projectId: claim.projectId, batchId: operation.operationId, title: operation.title,
    total: operation.total, readyDocumentIds: operation.documentIds
  })), 'pass the full persisted candidate set; the sidecar verifies source readiness');
  assert.equal(f.calls.find(([name]) => name === 'batches')[1], claim);
  assert.equal(f.calls.some(([name]) => name === 'retry'), false);
});

for (const status of ['missing', 'pending']) {
  test(`${status} source stays queued with a delay and still registers operation candidates`, async () => {
    const f = pipelineFixture({current: source({ready: false, status, revision: 0,
      error: {code: status === 'missing' ? 'wiki_source_missing' : 'wiki_paper_card_pending', retryable: true}})});
    queued(await f.run());
    assert.equal(f.calls.filter(([name]) => name === 'topic').length, 1);
    assert.equal(f.calls.some(([name]) => name === 'retry'), false);
  });
}

test('a later pending Topic prevents ready even when an earlier operation is ready', async () => {
  const f = pipelineFixture({operations: [batch(), batch({operationId: 'operation-2'})],
    topics: [topic(), topic({ready: false, status: 'pending', revision: 0})]});
  queued(await f.run());
  assert.equal(f.calls.filter(([name]) => name === 'topic').length, 2);
});

test('a verified project source without operation membership does not fabricate a Topic', async () => {
  const f = pipelineFixture({operations: []});
  assert.equal((await f.run()).status, 'ready');
  assert.equal(f.calls.some(([name]) => name === 'topic'), false);
});

for (const [status, code] of [['failed', 'wiki_paper_card_failed'], ['failed', 'wiki_source_failed'],
  ['stale', 'wiki_source_stale'], ['stale', 'wiki_source_invalid']]) {
  test(`${code} gets one Wiki-only retry, then fails on the next failed claim`, async () => {
    const current = source({ready: false, status, error: {code, retryable: true}});
    const f = pipelineFixture({current});
    queued(await f.run(job({attempts: 0})), 'research_literature_wiki_retrying');
    assert.deepEqual(f.calls.filter(([name]) => name === 'retry'), [['retry', 'project-1', 'doc-1']]);
    const failed = await f.run(job({attempts: 1}));
    assert.deepEqual(failed, {stage: 'wiki', status: 'failed', errorCode: `research_${code}`});
    assert.equal(f.calls.filter(([name]) => name === 'retry').length, 1);
    assert.equal(f.calls.some(([name]) => name === 'topic'), false);
  });
}

test('a nonretryable source failure fails on the first claim without retrying', async () => {
  const f = pipelineFixture({current: source({ready: false, status: 'failed',
    error: {code: 'wiki_source_invalid', retryable: false}})});
  assert.deepEqual(await f.run(), {stage: 'wiki', status: 'failed', errorCode: 'research_wiki_source_invalid'});
  assert.equal(f.calls.some(([name]) => name === 'retry'), false);
});

test('a retried source becomes ready on a later verified poll without another retry', async () => {
  const current = source({ready: false, status: 'failed', error: {code: 'wiki_source_failed', retryable: true}});
  const f = pipelineFixture({current});
  queued(await f.run(), 'research_literature_wiki_retrying');
  Object.assign(current, source());
  assert.equal((await f.run(job({attempts: 1}))).status, 'ready');
  assert.equal(f.calls.filter(([name]) => name === 'retry').length, 1);
});

test('human Topic coverage override is typed blocked and cannot become a successful source receipt', async () => {
  const f = pipelineFixture({topics: [topic({ready: false, status: 'pending',
    error: {code: 'wiki_topic_human_override', retryable: false}})]});
  assert.deepEqual(await f.run(), {stage: 'wiki', status: 'blocked', errorCode: 'research_wiki_topic_human_override'});
  assert.equal(f.calls.some(([name]) => name === 'retry'), false);
});

test('a failed Topic surfaces its typed failure without retrying the already-ready source', async () => {
  const f = pipelineFixture({topics: [topic({ready: false, status: 'failed',
    error: {code: 'wiki_topic_failed', retryable: true}})]});
  assert.deepEqual(await f.run(), {stage: 'wiki', status: 'failed', errorCode: 'research_wiki_topic_failed'});
  assert.equal(f.calls.some(([name]) => name === 'retry'), false);
});

test('library-only accepts verified global Paper Card publication and never enumerates or writes Topics', async () => {
  const f = pipelineFixture({current: source({publication: 'paper_card', pageId: null, revision: 0})});
  assert.deepEqual(await f.run(job({projectId: null})), {stage: 'wiki', status: 'ready', documentId: 'doc-1'});
  assert.deepEqual(f.calls, [['ensure', null, 'doc-1']]);
});

test('a missing document returns to import before any Wiki side effects', async () => {
  const f = pipelineFixture();
  assert.deepEqual(await f.run(job({documentId: null})), {stage: 'import', status: 'queued', documentId: null});
  assert.deepEqual(f.calls, []);
});

test('an already-cancelled signal fences every Wiki and membership call', async () => {
  const f = pipelineFixture(), controller = new AbortController(), reason = new Error('fixture_cancelled');
  controller.abort(reason);
  await assert.rejects(f.run(job(), controller.signal), error => error === reason);
  assert.deepEqual(f.calls, []);
});

test('an obsolete generation is fenced before source publication', async () => {
  const f = pipelineFixture(), reason = new Error('literature_acquisition_changed');
  await assert.rejects(f.run(job(), undefined, () => {throw reason;}), error => error === reason);
  assert.deepEqual(f.calls, []);
});

for (const mode of ['cancel', 'generation']) {
  test(`${mode} change during source preparation fences the retry side effect`, async () => {
    const controller = new AbortController(), reason = new Error(`fixture_${mode}`);
    let obsolete = false;
    const f = pipelineFixture({current: source({ready: false, status: 'failed',
      error: {code: 'wiki_source_failed', retryable: true}}),
      onEnsure: () => {if (mode === 'cancel') controller.abort(reason); else obsolete = true;}});
    await assert.rejects(f.run(job(), controller.signal, () => {if (obsolete) throw reason;}), error => error === reason);
    assert.equal(f.calls.some(([name]) => name === 'retry' || name === 'topic'), false);
  });
}

for (const mode of ['cancel', 'generation']) {
  test(`${mode} change after the first Topic fences every subsequent Topic`, async () => {
    const controller = new AbortController(), reason = new Error(`fixture_${mode}`);
    let obsolete = false;
    const f = pipelineFixture({operations: [batch(), batch({operationId: 'operation-2'})],
      onBatch: () => {if (mode === 'cancel') controller.abort(reason); else obsolete = true;}});
    await assert.rejects(f.run(job(), controller.signal, () => {if (obsolete) throw reason;}), error => error === reason);
    assert.equal(f.calls.filter(([name]) => name === 'topic').length, 1);
  });
}

test('generation change during the final Topic prevents returning ready', async () => {
  let obsolete = false;
  const reason = new Error('literature_acquisition_changed');
  const f = pipelineFixture({onBatch: () => {obsolete = true;}});
  await assert.rejects(f.run(job(), undefined, () => {if (obsolete) throw reason;}), error => error === reason);
});

function reconciliationFixture({jobs = [job({status: 'ready'})]} = {}) {
  const calls = [];
  const state = {selected: {id: 'embedding-1', revision: 2, model: 'fixture', dimensions: 3, enabled: 1},
    document: {id: 'doc-1', status: 'ready', currentParseId: 'parse-1', sourceHash: 'a'.repeat(64)},
    knowledgeJob: {status: 'ready'}, hasVectors: true,
    generation: {id: 'index-generation-1', snapshot: {paperIR: {identity: {parseId: 'parse-1', sourceHash: 'a'.repeat(64)}},
      embedding: {configId: 'embedding-1', revision: 2, model: 'fixture', dimensions: 3}}},
    source: source(), operations: [batch()], topic: topic({sources: [source(), source({documentId: 'doc-pending'}),
      source({documentId: 'doc-failed'})]})};
  const acquisitions = {
    completed() {calls.push(['completed']); return jobs;},
    invalidate(claim, stage) {calls.push(['invalidate', claim.id, stage]);},
    wikiBatches(claim) {calls.push(['batches', claim.id]); return claim.projectId === null ? [] : state.operations;}
  };
  const research = {
    knowledge: {listEmbeddingConfigRows() {return state.selected ? [state.selected] : [];},
      hasDocumentEmbeddings(...args) {calls.push(['vectors', ...args]); return state.hasVectors;}},
    documents: {get(documentId) {calls.push(['document', documentId]); return state.document;}},
    knowledgeJobs: {get(knowledgeId) {calls.push(['knowledge-job', knowledgeId]); return state.knowledgeJob;}},
    scientificIndex: {active(projectId, documentId) {calls.push(['active', projectId, documentId]); return state.generation;},
      verify(generationId) {calls.push(['verify', generationId]); if (state.verifyError) throw state.verifyError;}}
  };
  const wiki = {readSource(projectId, documentId) {calls.push(['source', projectId, documentId]);
    if (state.sourceError) throw state.sourceError; return state.source;},
    readBatch(projectId, operationId) {calls.push(['topic', projectId, operationId]);
      if (state.topicError) throw state.topicError; return state.topic;}};
  return {state, calls, run: () => reconcileAcquisitionReadiness(acquisitions, research, wiki),
    invalidated: () => calls.filter(([name]) => name === 'invalidate')};
}

test('completed reconciliation preserves verified index and partially covered usable Topic receipts', () => {
  const f = reconciliationFixture();
  f.run();
  assert.deepEqual(f.invalidated(), []);
  assert.deepEqual(f.calls.filter(([name]) => name === 'vectors'), [['vectors', 'document:parse-1', 'embedding-1', 2]]);
  assert.deepEqual(f.calls.filter(([name]) => name === 'verify'), [['verify', 'index-generation-1']]);
});

const indexChanges = [
  ['missing document', f => {f.state.document = null;}],
  ['missing embedding configuration', f => {f.state.selected = null;}],
  ['pending parse', f => {f.state.document.status = 'parsing';}],
  ['reparsed document', f => {f.state.document.currentParseId = 'parse-2';}],
  ['changed PDF hash', f => {f.state.document.sourceHash = 'b'.repeat(64);}],
  ['pending knowledge job', f => {f.state.knowledgeJob.status = 'queued';}],
  ['missing scientific generation', f => {f.state.generation = null;}],
  ['changed embedding revision', f => {f.state.selected.revision++;}],
  ['changed embedding model', f => {f.state.selected.model = 'replacement-model';}],
  ['changed embedding dimensions', f => {f.state.selected.dimensions++;}],
  ['missing generic vectors', f => {f.state.hasVectors = false;}],
  ['corrupt scientific generation', f => {f.state.verifyError = new Error('fixture_corrupt_index');}]
];
for (const [name, change] of indexChanges) {
  test(`completed reconciliation returns ${name} to index before considering Wiki`, () => {
    const f = reconciliationFixture(); change(f); f.run();
    assert.deepEqual(f.invalidated(), [['invalidate', 'acq-1', 'index']]);
    assert.equal(f.calls.some(([call]) => call === 'source' || call === 'topic'), false);
  });
}

const wikiChanges = [
  ['stale source', f => {f.state.source = source({ready: false, status: 'stale'});}],
  ['missing Topic', f => {f.state.topic = null;}],
  ['pending Topic', f => {f.state.topic.ready = false;}],
  ['changed requested total', f => {f.state.operations[0].total++;}],
  ['new operation candidate', f => {f.state.operations[0].documentIds.push('doc-late');}],
  ['source read failure', f => {f.state.sourceError = new Error('fixture_source_missing');}],
  ['Topic read failure', f => {f.state.topicError = new Error('fixture_topic_missing');}]
];
for (const [name, change] of wikiChanges) {
  test(`completed reconciliation returns ${name} to Wiki without invalidating its index`, () => {
    const f = reconciliationFixture(); change(f); f.run();
    assert.deepEqual(f.invalidated(), [['invalidate', 'acq-1', 'wiki']]);
    assert.equal(f.calls.filter(([name]) => name === 'verify').length, 1);
  });
}

test('library-only completed reconciliation needs a verified Paper Card and no project Topic', () => {
  const f = reconciliationFixture({jobs: [job({status: 'ready', projectId: null})]});
  f.run();
  assert.deepEqual(f.invalidated(), []);
  assert.deepEqual(f.calls.filter(([name]) => name === 'source'), [['source', null, 'doc-1']]);
  assert.equal(f.calls.some(([name]) => name === 'topic'), false);
});

test('completed reconciliation touches only the completed selection and performs no eager writes', () => {
  const f = reconciliationFixture({jobs: []});
  f.run();
  assert.deepEqual(f.calls, [['completed']]);
});
