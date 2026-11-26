import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir, writeFile, rm} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, services, registry;
async function loadCapabilityRegistry() {
  // The contract imports native capabilities; CJS leaves their installed dependencies with Node.
  const result = await build({entryPoints: ['src/main/plugins/research/research-plugin-knowledge.ts'],
    bundle: true, format: 'cjs', platform: 'node', packages: 'external', write: false, logLevel: 'silent'});
  const directory = resolve('.runtime/tmp'), file = resolve(directory, `capabilities-${randomUUID()}.cjs`);
  await mkdir(directory, {recursive: true});
  await writeFile(file, result.outputFiles[0].text);
  try {return (await import(pathToFileURL(file).href)).default;}
  finally {await rm(file, {force: true});}
}
before(async () => {
  [api, services, registry] = await Promise.all([
    loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-extraction-service.ts',
      {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}),
    loadCapabilityRegistry()
  ]);
});
after(() => api?.dispose());
const config = revision => ({extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'prompt/1',
  model: {provider: 'fixture', modelId: 'fixture-model', model: 'fixture-model', revision},
  inputTokens: 32_000, batchTokens: 8000});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const documentRequest = f => ({projectId: f.project.id, documentId: f.document.id});
const jobRequest = (f, job) => ({...documentRequest(f), generationId: job.id});
const read = (f, generationId = null) => f.service.read({...documentRequest(f), generationId});
const latest = f => f.repository.scientificExtraction.latest(f.project.id, f.document.id);
const empty = call => ({[call.name.replace('scientific_', '')]: []});

function proposals(call) {
  const input = JSON.parse(call.messages[1].content), table = input.batch.objects.find(o => o.objectType === 'Table');
  if (!table) return empty(call);
  const cell = text => {
    const value = table.content.cells.find(c => c.text === text);
    return {kind: 'table_cell', tableId: table.objectId, cellId: value.id, raw: value.text};
  };
  if (call.name === 'scientific_entities') return {entities: [
    {id: 'method', entityType: 'Method', canonicalName: {evidenceIndex: 0, firstToken: 0, lastToken: 1}, aliases: [],
      attributes: {description: null}, evidence: [cell('Original baseline')]},
    {id: 'metric', entityType: 'Metric', canonicalName: {evidenceIndex: 0, firstToken: 0, lastToken: 0}, aliases: [],
      attributes: {definition: null, direction: 'unknown', unit: '%'}, evidence: [cell('F1 (%)')]}
  ]};
  if (call.name === 'scientific_facts') return {facts: [{
    id: 'result', factType: 'experimental_result',
    subjectEntityId: input.entities.find(e => e.entityType === 'Method').id,
    predicate: 'Reported F1', objectEntityId: null, value: {raw: '90', unit: null, unitEvidence: []},
    conditions: {datasetId: null, datasetVersion: 'unknown', split: 'unknown',
      metricId: input.entities.find(e => e.entityType === 'Metric').id, baselineId: null, budget: 'unknown', other: {}},
    conditionEvidence: [{field: 'metricId', key: null, evidence: [cell('F1 (%)')]}],
    table: {tableId: table.objectId, cellId: cell('90').cellId, row: 1},
    evidence: [cell('90'), cell('Original baseline')], confidence: .8
  }]};
  return {relations: []};
}
async function setup({invoke = async call => proposals(call), ...options} = {}) {
  const f = await scientificSearchFixture(api, {embedded: false}), logs = [];
  let stamp = 'revision/1', unavailable = false, calls = 0;
  const factory = async () => {
    if (unavailable) throw new Error('private credential and source must not be persisted');
    const revision = stamp;
    return {config: config(revision), invoke: async (call, signal) => {
      calls++; return invoke(call, signal, revision, f);
    }};
  };
  const create = () => new services.ScientificExtractionService(f.repository, {library: f.root, index: null},
    factory, () => stamp, {pollMs: 60_000, logger: {warn: (...args) => logs.push(args)}, ...options});
  f.service = create();
  return Object.assign(f, {logs, create, calls: () => calls, revision: value => {stamp = value;},
    unavailable: () => {stamp = 'unavailable'; unavailable = true;}});
}
async function close(f) {await f.service.shutdown(); await f.close();}

test('production background owner publishes source-bound knowledge and deduplicates repeated scans', async () => {
  const f = await setup();
  try {
    f.service.start(); await f.service.idle();
    const result = await read(f), job = latest(f);
    assert.equal(result.state, 'current', JSON.stringify({job, logs: f.logs})); assert.equal(result.configurationError, null);
    assert.equal(job.status, 'published'); assert.equal(job.attempts, 1);
    assert.equal(result.knowledge.facts[0].value.raw, '90');
    assert.equal(result.knowledge.facts[0].value.normalized, '0.9');
    assert.equal(result.knowledge.facts[0].conditions.split, 'unknown');
    assert.equal(result.knowledge.facts[0].table.cellId, f.ir.tables[0].cells.find(c => c.text === '90').id);
    assert.ok(result.knowledge.facts[0].evidence.every(e => e.identity.parseId === f.ir.identity.parseId));
    assert.equal(f.db.prepare('SELECT count(*) FROM research_claims').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_relations').pluck().get(), 0);
    const calls = f.calls();
    f.service.wake(); await f.service.idle();
    assert.equal(latest(f).id, job.id); assert.equal(f.calls(), calls);
    assert.equal((await f.service.enqueue(documentRequest(f))).id, job.id);
  } finally {await close(f);}
});

test('failed replacement retains prior active knowledge and only explicit expected-generation retry runs again', async () => {
  let fail = false;
  const f = await setup({invoke: async call => {
    if (fail) throw new Error('private model output');
    return proposals(call);
  }});
  try {
    f.service.start(); await f.service.idle();
    const old = latest(f), original = f.repository.scientificExtraction.bundle(old.id, f.project.id);
    f.revision('revision/2'); fail = true; f.service.wake(); await f.service.idle();
    const failed = latest(f), calls = f.calls();
    assert.equal(failed.status, 'failed'); assert.equal(failed.generation, 2);
    assert.ok(!failed.error.includes('private'));
    assert.equal((await read(f)).publishedJob.id, old.id); assert.equal((await read(f)).state, 'stale');
    f.service.wake(); await f.service.idle(); assert.equal(f.calls(), calls);
    fail = false;
    const retry = await f.service.retry(jobRequest(f, failed));
    await f.service.idle();
    assert.equal(latest(f).id, retry.id); assert.equal(latest(f).status, 'published');
    assert.equal(retry.generation, 3);
    await assert.rejects(() => f.service.retry(jobRequest(f, failed)), /generation_changed/u);
    assert.deepEqual(f.repository.scientificExtraction.bundle(old.id, f.project.id), original);
  } finally {await close(f);}
});

test('model changes during inference cancel obsolete work and publish only the new configuration', async () => {
  let changed = false;
  const seen = [];
  const f = await setup({invoke: async (call, signal, revision, fixture) => {
    seen.push(revision);
    if (!changed) {
      changed = true; fixture.revision('revision/2'); fixture.service.wake();
      assert.equal(signal.aborted, true);
    }
    return proposals(call);
  }});
  try {
    f.service.start(); await f.service.idle();
    const jobs = f.repository.scientificExtraction.list(f.project.id, f.document.id);
    assert.equal(jobs.length, 2); assert.equal(jobs[0].status, 'published'); assert.equal(jobs[1].status, 'cancelled');
    assert.equal(jobs[0].snapshot.config.model.revision, 'revision/2');
    assert.equal(seen.filter(v => v === 'revision/1').length, 1);
    assert.equal((await read(f)).state, 'current');
  } finally {await close(f);}
});

test('reparse fences in-flight proposals and marks immutable prior facts stale', async () => {
  let reparse = false;
  const f = await setup({invoke: async (call, _signal, _revision, fixture) => {
    if (reparse) {reparse = false; await fixture.publish();}
    return proposals(call);
  }});
  try {
    f.service.start(); await f.service.idle(); const old = latest(f);
    const original = f.repository.scientificExtraction.bundle(old.id, f.project.id);
    reparse = true; f.revision('revision/2'); f.service.wake(); await f.service.idle();
    const jobs = f.repository.scientificExtraction.list(f.project.id, f.document.id);
    assert.equal(jobs.length, 3); assert.equal(jobs[1].status, 'cancelled');
    assert.equal(jobs[0].status, 'published');
    assert.equal(jobs[0].snapshot.source.paperIR.identity.parseId, 'fixture-parse-2');
    const history = await read(f, old.id);
    assert.equal(history.state, 'stale'); assert.equal(history.knowledge.facts[0].status, 'stale');
    assert.deepEqual(f.repository.scientificExtraction.bundle(old.id, f.project.id), original);
  } finally {await close(f);}
});

test('embedding-only replacement during inference uses the current receipt without extra extraction', async () => {
  let replaced = false;
  const f = await setup({invoke: async (call, _signal, _revision, fixture) => {
    if (!replaced) {
      replaced = true;
      const generation = fixture.repository.scientificIndex.begin({ir: fixture.ir, paperIR: fixture.data.paperIR,
        projectId: null, source: {kind: 'library'}, embedding: null, policy: {tableTokens: 128}});
      fixture.repository.scientificIndex.publish(generation.id, () => ({paperIR: fixture.data.paperIR, embedding: null}));
    }
    return proposals(call);
  }});
  try {
    f.service.start(); await f.service.idle();
    assert.equal(latest(f).status, 'published');
    assert.equal(f.repository.scientificExtraction.list(f.project.id, f.document.id).length, 1);
    assert.notEqual(f.repository.scientificIndex.active(null, f.document.id).id, latest(f).snapshot.source.generationId);
    assert.equal((await read(f)).state, 'current');
  } finally {await close(f);}
});

test('user cancellation stops an actual model wait and retry creates a separate generation', async () => {
  const entered = deferred(); let blocked = true;
  const f = await setup({invoke: async (call, signal) => {
    if (blocked) {
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }
    return proposals(call);
  }});
  try {
    f.service.start(); await entered.promise;
    const running = latest(f);
    assert.equal(f.service.cancel(jobRequest(f, running)).status, 'cancelled');
    await f.service.idle();
    assert.equal(latest(f).error, 'research_scientific_extraction_cancelled');
    assert.throws(() => f.service.cancel(jobRequest(f, running)), /not_cancellable/u);
    blocked = false;
    const next = await f.service.retry(jobRequest(f, running)); await f.service.idle();
    assert.equal(latest(f).status, 'published'); assert.notEqual(next.id, running.id);
    assert.throws(() => f.service.cancel(jobRequest(f, running)), /generation_changed/u);
  } finally {await close(f);}
});

test('shutdown leaves durable running work for restart recovery with attempts preserved', async () => {
  const entered = deferred(); let blocked = true;
  const f = await setup({invoke: async (call, signal) => {
    if (blocked) {
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }
    return proposals(call);
  }});
  try {
    f.service.start(); await entered.promise; const running = latest(f);
    await f.service.shutdown();
    assert.equal(latest(f).status, 'running'); assert.equal(latest(f).attempts, 1);
    await assert.rejects(() => read(f), /closed/u);
    blocked = false; f.service = f.create(); f.service.start(); await f.service.idle();
    assert.equal(latest(f).id, running.id); assert.equal(latest(f).status, 'published');
    assert.equal(latest(f).attempts, 2);
  } finally {await close(f);}
});

test('timeouts reach source/model boundaries and retain explicit retryable failure', async () => {
  const f = await setup({timeoutMs: 100, invoke: async (_call, signal) => {
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      if (signal.aborted) reject(signal.reason);
    });
  }});
  try {
    // A referenced timer keeps this unit's event loop alive while AbortSignal.timeout is unref'ed.
    const keepAlive = setInterval(() => {}, 1000);
    try {f.service.start(); await f.service.idle();} finally {clearInterval(keepAlive);}
    assert.equal(latest(f).status, 'failed');
    assert.equal((await read(f)).state, 'missing');
  } finally {await close(f);}
});

test('membership removal during inference denies current/history/jobs/retry/cancel and preserves rows', async () => {
  let remove = false;
  const f = await setup({invoke: async (call, _signal, _revision, fixture) => {
    if (remove) {
      remove = false;
      fixture.repository.library.link(fixture.document.libraryItemId, fixture.project.id, false, {notify: true});
    }
    return proposals(call);
  }});
  try {
    f.service.start(); await f.service.idle(); const old = latest(f);
    const original = f.repository.scientificExtraction.bundle(old.id, f.project.id);
    remove = true; f.revision('revision/2'); f.service.wake(); await f.service.idle();
    const cancelled = latest(f);
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(() => read(f), /scope_invalid/u);
    await assert.rejects(() => read(f, old.id), /scope_invalid/u);
    await assert.rejects(() => f.service.retry(jobRequest(f, cancelled)), /scope_invalid/u);
    assert.throws(() => f.service.cancel(jobRequest(f, cancelled)), /scope_invalid/u);
    assert.throws(() => f.repository.scientificExtraction.list(f.project.id, f.document.id), /scope_invalid/u);
    assert.deepEqual(f.repository.scientificExtraction.bundle(old.id, f.project.id), original);
  } finally {await close(f);}
});

test('unavailable model configuration preserves readable stale history with a sanitized error', async () => {
  const f = await setup();
  try {
    f.service.start(); await f.service.idle(); const old = latest(f);
    f.unavailable(); f.service.wake(); await f.service.idle();
    const result = await read(f);
    assert.equal(result.state, 'stale'); assert.equal(result.publishedJob.id, old.id);
    assert.ok(result.configurationError); assert.ok(!result.configurationError.includes('private'));
    await assert.rejects(() => f.service.enqueue(documentRequest(f)));
    assert.equal(latest(f).id, old.id);
  } finally {await close(f);}
});

test('all concurrent credential constructions are awaited on close while individual callers can abort', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  let stamp = 'one';
  const gates = [], started = deferred();
  const service = new services.ScientificExtractionService(f.repository, {library: f.root, index: null}, async () => {
    const gate = deferred(); gates.push(gate); if (gates.length === 2) started.resolve();
    await gate.promise; return {config: config('revision/1'), invoke: async call => empty(call)};
  }, () => stamp);
  try {
    const controller = new AbortController();
    const first = assert.rejects(() => service.enqueue(documentRequest(f), controller.signal));
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('caller_abort')); await first;
    stamp = 'two';
    const second = assert.rejects(() => service.enqueue(documentRequest(f)));
    await started.promise;
    let closed = false;
    const closing = service.shutdown().then(() => {closed = true;});
    gates[1].resolve(); await second;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'the earlier construction is still owned');
    gates[0].resolve(); await closing;
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_extraction_jobs').pluck().get(), 0);
  } finally {gates.forEach(g => g.resolve()); await service.shutdown(); await f.close();}
});

test('real knowledge capability handlers parse scoped requests and expose the production owner', async () => {
  const f = await setup(), handlers = new Map();
  try {
    registry.registerResearchKnowledge({capabilities: {register: (_plugin, descriptor, handler) =>
      handlers.set(descriptor.name, {descriptor, handler})}}, {
      researchRepository: f.repository, researchEmbeddings: f.embeddings, researchIndexer: {},
      scientificExtraction: f.service
    });
    const invoke = async (name, input) => {
      const entry = handlers.get(`research.knowledge.${name}`);
      assert.ok(entry);
      return entry.descriptor.outputSchema.parse(await entry.handler(entry.descriptor.inputSchema.parse(input)));
    };
    const job = await invoke('extractionEnqueue', documentRequest(f));
    assert.equal((await invoke('extractionJobs', documentRequest(f)))[0].id, job.id);
    assert.equal((await invoke('extractionCancel', jobRequest(f, job))).status, 'cancelled');
    const retry = await invoke('extractionRetry', jobRequest(f, job));
    f.service.start(); await f.service.idle();
    assert.equal((await invoke('scientificRead', {...documentRequest(f), generationId: null})).publishedJob.id, retry.id);
    await assert.rejects(() => invoke('extractionCancel', {...jobRequest(f, retry), projectId: 'foreign'}), /scope_invalid/u);
    await assert.rejects(() => invoke('extractionRetry', {documentId: f.document.id}));
  } finally {await close(f);}
});

test('completed durable batches resume after shutdown without republishing partial knowledge', async () => {
  const entered = deferred(); let blocked = true, invocations = 0;
  const f = await setup({invoke: async (call, signal) => {
    invocations++;
    if (blocked && invocations === 4) {
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }
    return proposals(call);
  }});
  try {
    f.service.start(); await entered.promise;
    const running = latest(f), receipts = f.repository.scientificExtraction.receipts(running.id, f.project.id);
    assert.equal(receipts.length, 3);
    assert.equal((await read(f)).knowledge, null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_facts').pluck().get(), 0);
    await f.service.shutdown();
    blocked = false; f.service = f.create(); f.service.start(); await f.service.idle();
    assert.equal(latest(f).status, 'published'); assert.equal(latest(f).attempts, 2);
    const trace = f.db.prepare("SELECT candidates_json FROM research_paper_extraction_jobs WHERE id=?").get(running.id);
    assert.equal(JSON.parse(trace.candidates_json).version, undefined, 'Publication replaces intermediate receipt envelope');
    const completed = invocations;
    f.revision('revision/2'); f.service.wake(); await f.service.idle();
    assert.equal(invocations - completed, completed - 1, 'Only the interrupted call repeats on restart; new revision executes every batch');
  } finally {await close(f);}
});

test('explicit retry reuses matching validated receipts and corrupt receipt bytes are never reused', async () => {
  let invocations = 0, fail = true;
  const f = await setup({invoke: async call => {
    invocations++;
    if (fail && invocations === 4) throw new Error('interrupted fixture');
    return proposals(call);
  }});
  try {
    f.service.start(); await f.service.idle();
    const failed = latest(f), store = f.repository.scientificExtraction;
    assert.equal(failed.status, 'failed'); assert.equal(store.receipts(failed.id, f.project.id).length, 3);
    fail = false; const retry = await f.service.retry(jobRequest(f, failed));
    assert.equal(store.receipts(retry.id, f.project.id).length, 3);
    assert.ok(store.receipts(retry.id, f.project.id).every(receipt => receipt.reusedFromJobId === failed.id));
    await f.service.idle(); assert.equal(latest(f).status, 'published');
    const previous = invocations;
    f.revision('revision/2'); fail = true; invocations = 0; f.service.wake(); await f.service.idle();
    const corrupt = latest(f);
    f.db.prepare("UPDATE research_paper_extraction_jobs SET candidates_hash=? WHERE id=?").run('0'.repeat(64), corrupt.id);
    assert.deepEqual(store.receipts(corrupt.id, f.project.id), []);
    fail = false; const again = await f.service.retry(jobRequest(f, corrupt));
    assert.deepEqual(store.receipts(again.id, f.project.id), []);
    await f.service.idle(); assert.equal(latest(f).status, 'published');
    assert.equal(invocations, previous + 3, 'Corrupt envelope forces all batches; matching retry previously skipped three');
  } finally {await close(f);}
});

const deepRequest = f => ({...documentRequest(f), purpose: 'reading', question: 'Explain the equation and its assumptions',
  dimensions: ['mathematical_formulation'], sectionIds: [], objectIds: [f.ir.equations[0].id]});
function deepProposals(call) {
  if (call.name !== 'scientific_deep_reading') return proposals(call);
  const {batch} = JSON.parse(call.messages[1].content), object = batch.objects[0];
  return {claims: [{id: 'explanation', dimension: 'mathematical_formulation', aspect: 'summary', objectId: object.objectId,
    provenance: 'model_inference', text: 'This is an explanatory reading, not a mathematical proof.',
    evidence: [{kind: 'object', objectType: 'Equation', objectId: object.objectId}]}], relationships: []};
}

test('deep knowledge is explicitly requested, source bound, unreviewed and retains original formula objects', async () => {
  const calls = [];
  const f = await setup({invoke: async call => {calls.push(call.name); return deepProposals(call);}});
  try {
    f.service.start(); await f.service.idle();
    const base = latest(f);
    assert.equal((await read(f)).knowledge.deepReading, undefined);
    assert.ok(!calls.includes('scientific_deep_reading'));
    const baseCalls = calls.length;
    const request = deepRequest(f), job = await f.service.requestDeep(request);
    await f.service.idle(); assert.equal(latest(f).id, job.id); assert.equal(latest(f).status, 'published', latest(f).error);
    const result = await f.service.readDeep({...documentRequest(f), generationId: null}), deep = result.knowledge.deepReading;
    assert.equal(result.state, 'current'); assert.equal(deep.status, 'source_validated');
    assert.equal(deep.scientificApproval, 'unreviewed'); assert.deepEqual(deep.objects.equations, f.ir.equations.slice(0, 1));
    assert.deepEqual(deep.objects.tables, []); assert.equal(calls.filter(name => name === 'scientific_deep_reading').length, 1);
    assert.equal(calls.length - baseCalls, 1, 'Deep request reuses matching complete base publication');
    const explanation = deep.claims.find(claim => claim.provenance === 'model_inference');
    assert.equal(explanation.scientificApproval, 'unreviewed');
    assert.deepEqual(explanation.evidence[0].identity, f.ir.identity);
    assert.equal(explanation.evidence[0].proposal.objectId, f.ir.equations[0].id);
    assert.ok(deep.claims.some(claim => claim.aspect === 'assumptions' && claim.provenance === 'unknown' && claim.text === 'unknown'));
    const before = calls.length; f.service.wake(); await f.service.idle(); assert.equal(calls.length, before);
    assert.equal((await f.service.requestDeep(request)).id, job.id);
    assert.equal((await read(f, base.id)).knowledge.deepReading, undefined);
    await assert.rejects(() => f.service.requestDeep({...request, objectIds: ['missing-object']}), /selection_invalid/u);
    f.revision('revision/2'); f.service.wake(); await f.service.idle();
    assert.equal((await read(f, job.id)).knowledge.deepReading.status, 'stale');
    assert.equal((await read(f)).knowledge.deepReading, undefined, 'Source/config refresh does not rerun explicit deep requests');
    assert.equal(calls.filter(name => name === 'scientific_deep_reading').length, 1);
  } finally {await close(f);}
});

test('deep failures preserve the prior publication and cannot promote invented cells or missing evidence', async () => {
  let mode = 'missing';
  const f = await setup({invoke: async call => {
    if (call.name !== 'scientific_deep_reading') return proposals(call);
    const output = deepProposals(call), claim = output.claims[0];
    if (mode === 'missing') claim.evidence = [];
    else if (mode === 'invented') {claim.aspect = 'raw_result'; claim.provenance = 'source_derived'; claim.text = '98.7';}
    else if (mode === 'authority') claim.scientificApproval = 'approved';
    return output;
  }});
  try {
    f.service.start(); await f.service.idle(); const original = latest(f);
    await f.service.requestDeep(deepRequest(f)); await f.service.idle();
    assert.equal(latest(f).status, 'failed'); assert.equal((await read(f)).publishedJob.id, original.id);
    for (const next of ['invented', 'authority']) {
      mode = next; await f.service.retry(jobRequest(f, latest(f))); await f.service.idle();
      assert.equal(latest(f).status, 'failed'); assert.equal((await read(f)).publishedJob.id, original.id);
    }
  } finally {await close(f);}
});

test('deep batch receipts resume only missing objects and revalidate selected sources', async () => {
  const entered = deferred(); let blocked = true, deepCalls = 0;
  const f = await setup({invoke: async (call, signal) => {
    if (call.name !== 'scientific_deep_reading') return proposals(call);
    deepCalls++;
    if (blocked && deepCalls === 2) {
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }
    const {batch} = JSON.parse(call.messages[1].content), object = batch.objects[0];
    return {claims: [{id: 'read-object', dimension: object.objectType === 'Equation' ? 'mathematical_formulation' : 'experiments',
      aspect: 'summary', objectId: object.objectId, provenance: 'source_derived', text: 'Original source object',
      evidence: [{kind: 'object', objectType: object.objectType, objectId: object.objectId}]}], relationships: []};
  }});
  try {
    f.service.start(); await f.service.idle(); const base = latest(f);
    const job = await f.service.requestDeep({...deepRequest(f), dimensions: ['mathematical_formulation', 'experiments'],
      objectIds: [f.ir.tables[0].id, f.ir.equations[0].id]});
    await entered.promise;
    assert.equal((await read(f)).publishedJob.id, base.id);
    const receipts = f.repository.scientificExtraction.receipts(job.id, f.project.id);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].stage, 'deep');
    assert.equal(receipts[0].output.entities.length, 0, 'Receipt stores batch delta rather than repeated base knowledge');
    assert.deepEqual(receipts[0].output.deepReading.objects, {tables: [], figures: [], equations: [], algorithms: []});
    await f.service.shutdown(); blocked = false;
    f.service = f.create(); f.service.start(); await f.service.idle();
    assert.equal(latest(f).id, job.id); assert.equal(latest(f).status, 'published', latest(f).error); assert.equal(deepCalls, 3);
    const result = (await read(f)).knowledge.deepReading;
    assert.equal(result.claims.filter(claim => claim.provenance === 'source_derived').length, 2);
    assert.deepEqual(result.objects.tables, [f.ir.tables[0]]); assert.deepEqual(result.objects.equations, [f.ir.equations[0]]);
  } finally {await close(f);}
});


test('a checksum-consistent receipt with forged source evidence is re-executed before publication', async () => {
  const entered = deferred(); let blocked = true, count = 0;
  const f = await setup({invoke: async (call, signal) => {
    count++;
    if (blocked && count === 2) {
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }
    return proposals(call);
  }});
  try {
    f.service.start(); await entered.promise; await f.service.shutdown();
    const job = latest(f), row = f.db.prepare('SELECT candidates_json FROM research_paper_extraction_jobs WHERE id=?').get(job.id);
    const envelope = JSON.parse(row.candidates_json), receipt = envelope.receipts[0];
    assert.ok(receipt.output.entities.length > 0);
    const evidence = receipt.output.entities[0].evidence[0];
    assert.equal(evidence.kind, 'table_cell'); evidence.raw = 'forged value';
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
    const hash = value => createHash('sha256').update(value).digest('hex');
    receipt.outputHash = hash(JSON.stringify(canonical(receipt.output)));
    const json = JSON.stringify(envelope);
    f.db.prepare('UPDATE research_paper_extraction_jobs SET candidates_json=?,candidates_hash=? WHERE id=?')
      .run(json, hash(json), job.id);
    assert.equal(f.repository.scientificExtraction.receipts(job.id, f.project.id).length, 1, 'Checksums alone do not validate sources');
    blocked = false; f.service = f.create(); f.service.start(); await f.service.idle();
    assert.equal(latest(f).status, 'published', latest(f).error);
    assert.ok((await read(f)).knowledge.entities.every(entity => entity.evidence.every(source => source.quote !== 'forged value')));
    const completed = count; f.revision('revision/2'); f.service.wake(); await f.service.idle();
    assert.equal(count - completed, completed - 2, 'Invalid source batch is invoked again despite valid receipt hashes');
  } finally {await close(f);}
});


test('figure summaries cannot invent numeric values or units and numerical model inferences remain rejected', async () => {
  let text = 'Figure 99 improved accuracy to 98.7%.', provenance = 'author_stated';
  const f = await setup({invoke: async call => {
    if (call.name !== 'scientific_deep_reading') return proposals(call);
    const {batch} = JSON.parse(call.messages[1].content), figure = batch.objects[0];
    const caption = batch.blocks.find(block => block.text.startsWith('Figure 2:'));
    assert.ok(caption);
    return {claims: [{id: 'figure-summary', dimension: 'results', aspect: 'summary', objectId: figure.objectId,
      provenance, text, evidence: [{kind: 'text', blockId: caption.blockId, start: caption.start,
        end: caption.end, quote: caption.text}]}], relationships: []};
  }});
  try {
    f.service.start(); await f.service.idle(); const base = latest(f);
    await f.service.requestDeep({...documentRequest(f), purpose: 'reading', question: 'Explain this figure',
      dimensions: ['results'], sectionIds: [], objectIds: [f.ir.figures[0].id]});
    await f.service.idle();
    assert.equal(latest(f).status, 'failed'); assert.match(latest(f).error, /figure_quantity_unsupported/u);
    assert.equal((await read(f)).publishedJob.id, base.id);
    for (const [nextText, nextProvenance] of [['2 FLOPs', 'source_derived'], ['Figure 2', 'model_inference']]) {
      text = nextText; provenance = nextProvenance;
      await f.service.retry(jobRequest(f, latest(f))); await f.service.idle();
      assert.equal(latest(f).status, 'failed'); assert.match(latest(f).error, /figure_quantity_unsupported/u);
    }
    text = 'Figure 2'; provenance = 'source_derived';
    await f.service.retry(jobRequest(f, latest(f))); await f.service.idle();
    assert.equal(latest(f).status, 'published', latest(f).error);
    const claim = (await read(f)).knowledge.deepReading.claims.find(item => item.provenance === 'source_derived');
    assert.equal(claim.text, 'Figure 2'); assert.equal(claim.scientificApproval, 'unreviewed');
  } finally {await close(f);}
});
