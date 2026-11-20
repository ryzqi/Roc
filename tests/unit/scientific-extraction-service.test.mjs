import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir, writeFile, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
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
    assert.equal(result.state, 'current'); assert.equal(result.configurationError, null);
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
