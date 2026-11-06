import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:net';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync('.artifacts/research-harness/S01', { recursive: true });
const root = realpathSync(mkdtempSync('.artifacts/research-harness/S01/adapter-'));
const workerPath = join(root, 'application-worker.mjs');
const adapterPath = join(root, 'adapter.mjs');
await build({ entryPoints: ['scripts/harness-eval/quality-evaluation/application-worker.ts'], outfile: workerPath,
  bundle: true, packages: 'external', platform: 'node', format: 'esm', loader: { '.md': 'text' }, logLevel: 'silent' });
await build({ entryPoints: ['scripts/harness-eval/quality-evaluation/application-adapter.ts'], outfile: adapterPath,
  bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
const api = await import(pathToFileURL(adapterPath).href);
const { importTypeScriptModule } = await import('../../scripts/lib/bundle-ts.mjs');
const dataApi = await importTypeScriptModule('scripts/harness-eval/quality-evaluation/dataset.ts', { platform: 'node' });
const runnerApi = await importTypeScriptModule('scripts/harness-eval/quality-evaluation/runner.ts', { platform: 'node' });
const protocolApi = await importTypeScriptModule('scripts/harness-eval/quality-evaluation/protocol.ts', { platform: 'node' });
const { dataset, expectations } = dataApi.loadQualityDatasetPackage('tests/fixtures/quality-evaluation/manifest.json',
  readFileSync('tests/fixtures/quality-evaluation/manifest.sha256', 'utf8').trim());
let networkConnections = 0;
const sentinel = createServer(socket => { networkConnections++; socket.end(); });
await new Promise(resolve => sentinel.listen(0, '127.0.0.1', resolve));
after(() => new Promise(resolve => sentinel.close(resolve)));
const manifestBase = { schemaVersion: 1, requestedCapabilities: { mcpServers: [], skills: [] },
  resolvedCapabilities: { mcpServers: [], skills: [] }, skippedCapabilities: [], tools: [], skills: [], mcpServers: [],
  untrustedContextPolicy: 'external_content_reference_only' };
const workers = Object.fromEntries(['baseline', 'candidate'].map((arm, i) => [arm, {
  path: workerPath, sha256: createHash('sha256').update(readFileSync(workerPath)).digest('hex'),
  // These are contract test identities, never scientific baseline/candidate commits.
  commitSha: String(i + 1).repeat(40), nodeModulesPath: realpathSync('node_modules'), nodeVersion: process.version,
  lockfilePath: realpathSync('pnpm-lock.yaml'),
  lockfileSha256: createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex')
}]));
const secretPath = join(root, 'hidden-expectation.txt');
writeFileSync(secretPath, 'hidden evaluator sentinel');
const protectedPaths = [secretPath, realpathSync('tests/fixtures/quality-evaluation')];
const binding = { evidence: 'fixture', providerId: 'loopback-fixture', baselineModelId: 'fixture-model', candidateModelId: 'fixture-model',
  baselineCommitSha: workers.baseline.commitSha, candidateCommitSha: workers.candidate.commitSha,
  toolManifestHash: createHash('sha256').update(JSON.stringify(manifestBase)).digest('hex'),
  environmentHash: api.qualityApplicationEnvironmentHash(workers, protectedPaths), pricingVersion: 'fixture-v1', temperature: 0,
  isolation: 'process-files-tools', isolationHash: api.qualityIsolationHash(),
  maxRequestsPerTask: 2, maxRequestCostMicrousd: 10 };
let requests = 0;
const transport = { providerId: binding.providerId, pricingVersion: binding.pricingVersion,
  async complete({ body, maximumCostMicrousd }) {
    requests++;
    assert.equal(maximumCostMicrousd, 10);
    assert.equal(JSON.stringify(body).includes('hidden evaluator sentinel'), false);
    return { costMicrousd: 1, body: { id: 'fixture-response', object: 'chat.completion', created: 0,
      model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } } };
  } };
const executor = api.createApplicationQualityExecutor({ binding, workers, protectedPaths, artifactsRoot: root,
  transport, maxRequestsPerTask: 2, maxRequestCostMicrousd: 10,
  isolationProbePaths: [secretPath, realpathSync('tests/fixtures/quality-evaluation/manifest.json')],
  isolationProbePort: sentinel.address().port });

test('application Harness runs in isolated process with real budget, checkpoint and stdio transport', async () => {
  const events = [];
  const result = await executor.execute({ id: 'application-fixture', family: 'file-report', difficulty: 'easy',
    prompt: 'Return a JSON object.', outputFormat: 'json' }, {
    arm: 'baseline', trialId: 'application-fixture:0:baseline', repeatIndex: 0, maximumCostMicrousd: 20,
    signal: new AbortController().signal, recordRequest: async event => events.push(event)
  });
  // Measure the application's terminal response exactly. Its current stream collector
  // includes the context contract preamble; the evaluator must retain and reject it.
  assert.ok(result.output.endsWith('{"ok":true}'));
  assert.throws(() => JSON.parse(result.output), SyntaxError);
  assert.equal(result.costMicrousd, 1);
  assert.equal(requests, 1);
  assert.equal(events.length, 1);
  const trialRoot = join(root, createHash('sha256').update('application-fixture:0:baseline').digest('hex'));
  assert.ok(readFileSync(join(trialRoot, 'worker', 'agent.sqlite')).length > 0);
  const transcript = readFileSync(join(trialRoot, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(transcript.find(row => row.type === 'result').output, result.output);
  assert.ok(transcript.some(row => row.event?.type === 'run_completed'));
  assert.ok(transcript.some(row => row.type === 'isolation' && row.filesDenied && row.childDenied));
  assert.ok(transcript.some(row => row.type === 'isolation' && row.networkDenied));
  assert.equal(networkConnections, 0);
  assert.equal(JSON.parse(readFileSync(join(trialRoot, 'cleanup.json'), 'utf8')).processGroupGone, true);
});

function protocol(id) {
  return protocolApi.lockQualityProtocol(dataset, protocolApi.createQualityProtocolDraft(dataset, id), {
    ...binding, executionMode: 'fixture', authorizationLevel: 'L1', taskTimeoutMs: 5000,
    promptSetHash: runnerApi.qualityPromptSetHash(dataset, 'fixture'),
    maxTotalCostUsd: 0.00002, maxPerTaskCostUsd: 0.00002, userAuthorized: true, approvalReference: 'local-contract-only'
  });
}

test('application requests use the durable runner journal before dispatch and retain actual invalid output', async () => {
  const journalRoot = join(root, 'journal-normal');
  const locked = protocol('application-journal-fixture');
  let called = 0;
  const checked = api.createApplicationQualityExecutor({ binding, workers, protectedPaths, artifactsRoot: journalRoot,
    maxRequestsPerTask: 2, maxRequestCostMicrousd: 10, transport: { ...transport, async complete(input) {
      called++;
      const rows = readFileSync(join(journalRoot, 'quality', `${locked.lockHash}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).type, 'request');
      assert.equal(rows.at(-1).requestHash, dataApi.qualityHash(input.body));
      return transport.complete(input);
    } } });
  mkdirSync(journalRoot);
  const saved = await runnerApi.runQualityEvaluationWithJournal({ dataset, expectations, protocol: locked,
    executor: checked, artifactsRoot: journalRoot, signal: new AbortController().signal });
  assert.equal(called, 1);
  assert.equal(saved.result.dispatches, 1);
  assert.equal(saved.result.trials.length, 48);
  assert.ok(saved.result.validations.some(row => row.validation?.failures.includes('output_not_json')));
  assert.equal(saved.result.statistics.evidenceStatus, 'insufficient');
});

test('provider quote violation stops later application dispatch and retains unknown spend', async () => {
  const costRoot = join(root, 'quote-violation');
  mkdirSync(costRoot);
  let called = 0;
  const checked = api.createApplicationQualityExecutor({ binding, workers, protectedPaths, artifactsRoot: costRoot,
    maxRequestsPerTask: 2, maxRequestCostMicrousd: 10, transport: { ...transport, async complete(input) {
      called++;
      const response = await transport.complete(input);
      return { ...response, costMicrousd: 11 };
    } } });
  const result = await runnerApi.runQualityEvaluation({ dataset, expectations, protocol: protocol('application-quote-fixture'),
    executor: checked, signal: new AbortController().signal, writeEvent: async () => {} });
  assert.equal(called, 1);
  assert.equal(result.dispatches, 1);
  assert.equal(result.stopReason, 'executor_cost_ceiling_violated');
  assert.equal(result.unknownCalls, 1);
  assert.equal(result.heldCostMicrousd, 20);
});

test('cancelled application request cleans the process tree and cannot accept a late response', async () => {
  const cancelRoot = join(root, 'cancel');
  mkdirSync(cancelRoot);
  const controller = new AbortController();
  const checked = api.createApplicationQualityExecutor({ binding, workers, protectedPaths, artifactsRoot: cancelRoot,
    maxRequestsPerTask: 2, maxRequestCostMicrousd: 10, transport: { ...transport, async complete(input) {
      controller.abort(new Error('local test cancellation'));
      return transport.complete(input);
    } } });
  await assert.rejects(checked.execute({ id: 'cancel-fixture', family: 'cancel-crash', difficulty: 'hard',
    prompt: 'Return JSON.', outputFormat: 'json' }, { arm: 'baseline', trialId: 'cancel-fixture:0:baseline',
    repeatIndex: 0, maximumCostMicrousd: 20, signal: controller.signal, recordRequest: async () => {} }));
  const trial = join(cancelRoot, createHash('sha256').update('cancel-fixture:0:baseline').digest('hex'));
  assert.equal(JSON.parse(readFileSync(join(trial, 'cleanup.json'), 'utf8')).processGroupGone, true);
});

test('application adapter rejects changed worker or quote contract before provider dispatch', () => {
  assert.throws(() => api.createApplicationQualityExecutor({ binding, protectedPaths, workers: { ...workers,
    baseline: { ...workers.baseline, sha256: 'a'.repeat(64) } }, artifactsRoot: root,
    transport, maxRequestsPerTask: 2, maxRequestCostMicrousd: 10 }), /worker_changed/);
  assert.throws(() => api.createApplicationQualityExecutor({ binding, workers, protectedPaths, artifactsRoot: root,
    transport, maxRequestsPerTask: 3, maxRequestCostMicrousd: 10 }), /binding_invalid/);
  assert.throws(() => api.createApplicationQualityExecutor({ binding, protectedPaths, workers: { ...workers,
    candidate: { ...workers.candidate, lockfileSha256: 'b'.repeat(64) } }, artifactsRoot: root,
    transport, maxRequestsPerTask: 2, maxRequestCostMicrousd: 10 }), /dependency_versions_differ/);
});

test('provider transport failure remains classified and preserves the reservation after cleanup', async () => {
  const failureRoot = join(root, 'provider-failure');
  mkdirSync(failureRoot);
  let called = 0;
  const checked = api.createApplicationQualityExecutor({ binding, workers, protectedPaths, artifactsRoot: failureRoot,
    maxRequestsPerTask: 2, maxRequestCostMicrousd: 10, transport: { ...transport, async complete() {
      called++;
      throw new Error('local transport unavailable');
    } } });
  const result = await runnerApi.runQualityEvaluation({ dataset, expectations,
    protocol: protocol('application-provider-failure'), executor: checked,
    signal: new AbortController().signal, writeEvent: async () => {} });
  assert.equal(called, 1);
  assert.equal(result.dispatches, 1);
  assert.equal(result.unknownCalls, 1);
  assert.equal(result.heldCostMicrousd, 20);
  assert.equal((result.statistics.failureCounts.baseline.provider ?? 0)
    + (result.statistics.failureCounts.candidate.provider ?? 0), 1);
  const outcome = [result.trials[0].baseline, result.trials[0].candidate].find(row => row.failureClass === 'provider');
  assert.ok(outcome);
  for (const arm of ['baseline', 'candidate']) {
    if (result.trials[0][arm].failureClass !== 'provider') continue;
    const trial = join(failureRoot, createHash('sha256').update(`${dataset.tasks[0].id}:0:${arm}`).digest('hex'));
    assert.equal(JSON.parse(readFileSync(join(trial, 'cleanup.json'), 'utf8')).processGroupGone, true);
  }
});
