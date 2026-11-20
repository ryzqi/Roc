import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
const compiled = await build({stdin: {contents: `export {LiteratureSearchService} from './src/main/plugins/research/literature-service';
export {LiteratureProviderGovernor, researchProviderHosts} from './src/main/plugins/research/literature-provider-governor';`, resolveDir: process.cwd()},
  bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false, logLevel: 'silent'});
const {LiteratureSearchService, LiteratureProviderGovernor, researchProviderHosts} = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const protocol = {samples: 5, fetchLatencyMs: 25, requestP95TargetMs: 1000, cancelP95TargetMs: 250,
  policy: {minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 3, cooldownMs: 60000},
  cache: {maxEntries: 32, maxBytes: 8388608, ttlMs: 300000}, policyClock: 'virtual; waits advance policy time only', latencyClock: 'real performance.now'};
function fixture(fetcher, overrides = {}) {
  let now = Date.parse('2026-11-06T00:00:00Z'); const waits = [], dispatches = [];
  const policy = {...protocol.policy, ...overrides};
  const governor = new LiteratureProviderGovernor(Object.fromEntries(Object.values(researchProviderHosts).map(host => [host, policy])), () => now,
    async (ms, signal) => {signal.throwIfAborted(); waits.push(ms); now += ms;});
  const service = new LiteratureSearchService(async (url, init) => {
    dispatches.push({host: new URL(url).host, policyTime: now, wallStartMs: performance.now()});
    await delay(protocol.fetchLatencyMs, undefined, {signal: init.signal}); return fetcher(url, init);
  }, governor);
  const read = (id, source = 'crossref', signal, projectId = 'project-a') => service.readProviderJson({source,
    url: `https://${researchProviderHosts[source]}/fixture?id=${id}`, projectId, timeoutMs: 10000}, payload => {
    if (payload.ok !== true) throw new Error('literature_provider_response_invalid'); return payload;
  }, signal);
  return {service, read, waits, dispatches, governor, advance: ms => {now += ms;}};
}
const samples = [];
async function measured(name, action) {const start = performance.now(); const result = await action(); return {name, elapsedMs: performance.now() - start, ...result};}
for (let sample = 0; sample < protocol.samples; sample++) {
  const rows = [];
  const cache = fixture(() => Response.json({ok: true}));
  try {
    rows.push(await measured('cold-cache', async () => {const receipt = await cache.read('cache'); assert.equal(receipt.status, 'ok'); assert.equal(receipt.cache, 'miss'); return {receipt};}));
    rows.push(await measured('warm-cache', async () => {const receipt = await cache.read('cache'); assert.equal(receipt.cache, 'hit'); assert.equal(receipt.requests.length, 0); return {receipt};}));
    const foreign = await cache.read('cache', 'crossref', undefined, 'project-b'); assert.equal(foreign.cache, 'miss'); assert.equal(cache.dispatches.length, 2);
  } finally {await cache.service.shutdown();}
  const quota = fixture(() => Response.json({ok: true}), {maxRequests: 2});
  try {
    await quota.read('q1'); await quota.read('q2');
    const denied = await quota.read('q3'); assert.equal(denied.errorCode, 'literature_provider_quota_exhausted'); assert.equal(denied.requests.length, 0);
    const hit = await quota.read('q1'); assert.equal(hit.cache, 'hit'); assert.equal(hit.governance.state, 'quota_exhausted');
    quota.advance(protocol.policy.windowMs); const recovery = await quota.read('q3'); assert.equal(recovery.status, 'ok');
    rows.push({name: 'quota-reset', denied, cached: hit, recovery, dispatches: quota.dispatches, waits: quota.waits});
  } finally {await quota.service.shutdown();}
  let attempts = 0;
  const retry = fixture(() => ++attempts === 1 ? new Response('limited', {status: 429, headers: {'retry-after': '2'}}) : Response.json({ok: true}));
  try {
    rows.push(await measured('429-retry', async () => {const receipt = await retry.read('retry'); assert.deepEqual(receipt.requests.map(r => r.status), [429, 200]);
      assert.equal(receipt.governance.state, 'healthy'); assert.equal(retry.dispatches[1].policyTime - retry.dispatches[0].policyTime, 2000);
      return {receipt, dispatches: retry.dispatches, policyWaits: retry.waits};}));
  } finally {await retry.service.shutdown();}
  attempts = 0;
  const failure = fixture(() => ++attempts <= 2 ? new Response('failure', {status: 500}) : Response.json({ok: true}));
  try {
    rows.push(await measured('500-retry', async () => {const receipt = await failure.read('retry'); assert.deepEqual(receipt.requests.map(r => r.status), [500, 500, 200]);
      assert.equal(receipt.governance.state, 'healthy'); return {receipt, dispatches: failure.dispatches, policyWaits: failure.waits};}));
  } finally {await failure.service.shutdown();}
  let valid = false;
  const health = fixture(() => Response.json(valid ? {ok: true} : {error: 'invalid'}));
  try {
    const failures = []; for (let i = 0; i < 3; i++) {const result = await health.read('invalid'); assert.equal(result.errorCode, 'literature_provider_response_invalid'); failures.push(result);}
    const denied = await health.read('invalid'); assert.equal(denied.errorCode, 'literature_provider_cooldown'); assert.equal(health.dispatches.length, 3);
    health.advance(protocol.policy.cooldownMs); valid = true; const recovered = await health.read('invalid'); assert.equal(recovered.governance.state, 'healthy');
    rows.push({name: 'invalid-circuit-recovery', failures, denied, recovered, dispatches: health.dispatches, policyWaits: health.waits});
  } finally {await health.service.shutdown();}
  let startedResolve; const started = new Promise(resolve => {startedResolve = resolve;});
  const cancellation = fixture((url, init) => {
    if (new URL(url).host === researchProviderHosts.openalex) return Response.json({ok: true});
    startedResolve(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  });
  const activeController = new AbortController(), queuedController = new AbortController();
  const active = cancellation.read('active', 'crossref', activeController.signal), queued = cancellation.read('queued', 'crossref', queuedController.signal);
  const activeRejected = assert.rejects(active, /fixture_inflight_cancel/u), queuedRejected = assert.rejects(queued, /fixture_queued_cancel/u);
  try {
    await started; await nextTurn(); assert.equal(cancellation.dispatches.length, 1);
    rows.push(await measured('queued-cancel', async () => {queuedController.abort(new Error('fixture_queued_cancel')); await queuedRejected; return {dispatchesAtCancel: cancellation.dispatches.length};}));
    const independent = await cancellation.read('independent', 'openalex'); assert.equal(independent.status, 'ok');
    rows.push(await measured('inflight-cancel', async () => {activeController.abort(new Error('fixture_inflight_cancel')); await activeRejected;
      assert.equal(cancellation.governor.observe(researchProviderHosts.crossref).consecutiveFailures, 0); return {health: cancellation.governor.observe(researchProviderHosts.crossref)};}));
    assert.deepEqual(cancellation.dispatches.map(d => d.host), [researchProviderHosts.crossref, researchProviderHosts.openalex]);
    const after = await cancellation.read('independent', 'openalex'); assert.equal(after.cache, 'hit');
    await cancellation.service.shutdown(); await assert.rejects(cancellation.read('closed'), /literature_service_closed/u);
    rows.push({name: 'independent-host-and-shutdown', independent, dispatches: cancellation.dispatches});
  } finally {activeController.abort(); queuedController.abort(); await Promise.allSettled([active, queued, activeRejected, queuedRejected]); await cancellation.service.shutdown();}
  samples.push(rows); console.log(JSON.stringify({sample, timings: rows.filter(r => r.elapsedMs !== undefined).map(({name, elapsedMs}) => ({name, elapsedMs}))}));
}
const percentile = values => [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95)-1];
const timings = Object.fromEntries(samples[0].filter(r => r.elapsedMs !== undefined).map(({name}) => [name, {p95Ms: percentile(samples.map(rows => rows.find(r => r.name === name).elapsedMs))}]));
for (const [name, value] of Object.entries(timings)) assert.ok(value.p95Ms < (name.endsWith('cancel') ? protocol.cancelP95TargetMs : protocol.requestP95TargetMs), `${name}_p95_target`);
const paths = ['scripts/benchmark-research-network.mjs', 'src/main/plugins/research/literature-service.ts', 'src/main/plugins/research/literature-provider-governor.ts', 'src/main/plugins/research/literature-response-cache.ts'];
const report = {contractVersion: 1, protocol, protocolSha256: createHash('sha256').update(JSON.stringify(protocol)).digest('hex'), timings, samples,
  sourceHashes: Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
  hardware: {cpu: cpus()[0].model, memoryBytes: totalmem(), node: process.version, platform: process.platform, arch: process.arch},
  limits: 'Production service/governor/cache; scripted in-process fetch, no sockets or provider calls. Policy waits use virtual time; fetch latency, built-in 250/500ms retry delays and cancellation use real wall time. Five samples give descriptive maxima, not Internet throughput. Shutdown regression also covers active provider work in literature-import.test.mjs.'};
const output = resolve(process.argv[2] ?? '.artifacts/research-optimization/network-current.json'); await mkdir(dirname(output), {recursive: true}); await writeFile(output, JSON.stringify(report, null, 2)+'\n');
