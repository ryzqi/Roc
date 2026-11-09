import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const api = await importTypeScriptModule('scripts/harness-eval/quality-evaluation/runner.ts', { platform: 'node' });
const { readFileSync } = await import('node:fs');
const datasetApi = await importTypeScriptModule('scripts/harness-eval/quality-evaluation/dataset.ts', { platform: 'node' });
const { dataset, expectations } = datasetApi.loadQualityDatasetPackage('tests/fixtures/quality-evaluation/manifest.json',
  readFileSync('tests/fixtures/quality-evaluation/manifest.sha256', 'utf8').trim());
const protocolApi = await importTypeScriptModule('scripts/harness-eval/quality-evaluation/protocol.ts', { platform: 'node' });

function fixture(overrides = {}) {
  const lock = {
    executionMode: 'fixture', authorizationLevel: 'L1', providerId: 'fixture',
    baselineModelId: 'same-model', candidateModelId: 'same-model',
    baselineCommitSha: 'a'.repeat(40), candidateCommitSha: 'b'.repeat(40),
    toolManifestHash: 'c'.repeat(64), environmentHash: 'd'.repeat(64), promptSetHash: api.qualityPromptSetHash(dataset, 'fixture'),

    temperature: 0, isolationHash: 'f'.repeat(64),
    taskTimeoutMs: 1000,
    userAuthorized: true, approvalReference: 'fixture-only', ...overrides
  };
  const protocol = protocolApi.lockQualityProtocol(dataset, protocolApi.createQualityProtocolDraft(dataset, 'unit-quality-runner'), lock);
  const events = [];
  const calls = [];
  const executor = {
    binding: { evidence: 'fixture', providerId: lock.providerId,
      baselineModelId: lock.baselineModelId, candidateModelId: lock.candidateModelId,
      baselineCommitSha: lock.baselineCommitSha, candidateCommitSha: lock.candidateCommitSha,
      toolManifestHash: lock.toolManifestHash, environmentHash: lock.environmentHash,
      temperature: lock.temperature, isolationHash: lock.isolationHash, isolation: 'fixture-object',
       },
    async execute(view, context) {
      calls.push({ view, context });
      return { output: null, };
    }
  };
  const signal = new AbortController().signal;
  return { protocol, lock, events, calls, executor,
    run: (override = {}) => api.runQualityEvaluation({ dataset, expectations, protocol, executor, signal,
      writeEvent: async (event) => { events.push(structuredClone(event)); }, ...override }) };
}

test('protocol v3 pins commit identity and permits same-model harness comparison', () => {
  const f = fixture();
  assert.equal(f.protocol.schemaVersion, 3);
  assert.equal(f.protocol.lock.baselineModelId, f.protocol.lock.candidateModelId);
  assert.throws(() => fixture({ candidateCommitSha: 'a'.repeat(40) }), /quality_protocol_comparison_identical/);
  assert.throws(() => fixture({ baselineCommitSha: 'HEAD' }), /quality_protocol_commit_invalid/);
});

test('one-use journal records protocol and outcomes and refuses automatic rerun after restart', async () => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), 'roc-quality-journal-'));
  try {
    const input = { dataset, expectations, protocol: f.protocol, executor: f.executor, signal: new AbortController().signal, artifactsRoot: root };
    const saved = await api.runQualityEvaluationWithJournal(input);
    const rows = (await readFile(saved.journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows[0].protocol.lockHash, f.protocol.lockHash);
    assert.equal(rows.at(-1).type, 'completed');
    assert.equal(rows.filter((row) => row.type === 'dispatched').length, 96);
    assert.equal(JSON.parse(await readFile(saved.reportPath, 'utf8')).evidence, 'fixture');
    await assert.rejects(api.runQualityEvaluationWithJournal(input), { code: 'EEXIST' });
    assert.equal(f.calls.length, 96);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('independent validator accepts a visible-input answer without passing hidden fields to adapter', async () => {
  const f = fixture();
  f.executor.execute = async (view) => ({
    output: view.id === 'permission-injection-untrusted-document'
      ? JSON.stringify({ decision: 'blocked', blockedAction: 'upload_secret', executedActions: ['read_evidence_bundle'] }) : null,
    });
  const result = await f.run();
  assert.equal(result.statistics.baselinePassRate, 1 / 16);
  assert.equal(result.statistics.candidatePassRate, 1 / 16);
  assert.equal(result.validations.filter((entry) => entry.validation?.passed).length, 6);
  assert.equal(result.statistics.conclusion, 'uncertain');
});

test('runner preserves fixed paired denominator, counterbalances order and hides all evaluator truth', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.evidence, 'fixture');
  assert.equal(result.dispatches, 96);
  assert.equal(result.trials.length, 48);
  assert.equal(result.statistics.taskCount, 16);
  assert.equal(result.statistics.conclusion, 'uncertain');
  assert.ok(new Set(f.calls.map((call) => call.context.arm)).size === 2);
  for (let i = 0; i < f.calls.length; i += 2) assert.notEqual(f.calls[i].context.arm, f.calls[i + 1].context.arm);
  for (const { view } of f.calls) {
    for (const hidden of ['validator', 'sourceIds', 'clusterId', 'split', 'provenance']) {
      assert.equal(Object.hasOwn(view, hidden), false);
    }
    assert.equal(Object.isFrozen(view), true);
  }
  assert.equal(f.events[0].type, 'started');
  assert.equal(f.events.at(-1).type, 'completed');
  assert.ok(result.trials.every((trial) => trial.baseline.failureClass === 'agent' && trial.candidate.failureClass === 'agent'));
});

test('all paired trials dispatch without financial metadata or cumulative quotas', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.dispatches, 96);
  assert.equal(f.calls.length, 96);
  assert.equal(result.stopReason, null);
  assert.equal(result.trials.length, 48);
});

test('runner rejects binding and prompt drift or missing authorization before execution', async () => {
  const f = fixture();
  f.executor.binding.baselineCommitSha = 'e'.repeat(40);
  await assert.rejects(f.run(), /quality_runner_binding_mismatch:baselineCommitSha/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 0);
  const changed = fixture({ promptSetHash: 'e'.repeat(64) });
  await assert.rejects(changed.run(), /quality_runner_prompt_set_changed/);
  const draft = protocolApi.createQualityProtocolDraft(dataset, 'unit-quality-runner');
  await assert.rejects(f.run({ protocol: draft }), /quality_eval_authorization_required/);
});

test('a caller cannot change the active protocol after dispatch', async () => {
  const f = fixture();
  let tampered = false;
  f.executor.execute = async () => {
    if (!tampered) {
      f.protocol.lock.temperature = 0.7;
      f.protocol.repeatsPerTask = 100;
      tampered = true;
    }
    return { output: null, };
  };
  const result = await f.run();
  assert.equal(result.trials.length, 48);
  assert.equal(result.dispatches, 96);
});

test('journal failure blocks dispatch; provider errors and unsafe outputs stay in denominator', async () => {
  const f = fixture();
  await assert.rejects(f.run({ writeEvent: async (event) => {
    if (event.type === 'dispatched') throw new Error('journal_unavailable');
  } }), /journal_unavailable/);
  assert.equal(f.calls.length, 0);
  const errors = fixture();
  // The adapter rejects with a classified failure from the same loaded module.
  errors.executor.execute = async () => { throw new api.QualityExecutionFailure('provider'); };
  const failed = await errors.run();
  assert.equal(failed.dispatches, 96);
  assert.equal(failed.statistics.failureCounts.baseline.provider, 48);
  const invalid = fixture();
  invalid.executor.execute = async () => ({ output: 'x'.repeat(65 * 1024), });
  const bad = await invalid.run();
  assert.equal(bad.validations[0].validation.passed, false);
  assert.deepEqual(bad.validations[0].validation.failures, ['output_too_large']);
  assert.equal(bad.trials[0].baseline.failureClass, 'agent');
});


test('timeout aborts executor and prevents any later dispatch when cleanup is unconfirmed', async () => {
  const f = fixture();
  let aborted = false;
  f.executor.execute = async (_view, context) => {
    context.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  };
  const result = await f.run();
  assert.equal(aborted, true);
  assert.equal(result.dispatches, 1);
  assert.equal(result.stopReason, 'executor_abort_unconfirmed');
  assert.ok([result.trials[0].baseline.failureClass, result.trials[0].candidate.failureClass].includes('infra'));
  assert.equal(result.trials.length, 48);
});

test('request admission rejects malformed hashes and journal failures before transport work', async () => {
  const over = fixture();
  let transportCalls = 0;
  over.executor.execute = async (_view, context) => {
    await context.recordRequest({ requestHash: 'invalid' });
    transportCalls++;
    return { output: null, };
  };
  const denied = await over.run();
  assert.equal(transportCalls, 0);
  assert.equal(denied.dispatches, 1);
  assert.equal(denied.stopReason, 'executor_request_invalid');
  const journal = fixture();
  journal.executor.execute = async (_view, context) => {
    await context.recordRequest({ requestHash: 'a'.repeat(64), });
    transportCalls++;
    return { output: null, };
  };
  const failed = await journal.run({ writeEvent: async event => {
    if (event.type === 'request') throw new Error('disk unavailable');
  } });
  assert.equal(transportCalls, 0);
  assert.equal(failed.dispatches, 1);
  assert.equal(failed.stopReason, 'executor_journal_failed');
});
