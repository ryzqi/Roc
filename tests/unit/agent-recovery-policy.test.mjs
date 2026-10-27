import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const bundleOptions = {
  platform: 'node',
  tempDir: join(repositoryRoot, '.runtime/tmp')
};
const { classifyFailure } = await importTypeScriptModule(
  'src/main/services/deep-agent/structured-failure.ts',
  bundleOptions
);
const { toRecoveryDecision } = await importTypeScriptModule(
  'src/main/plugins/agent/recovery-policy.ts',
  bundleOptions
);

function runFailure(code, message, retryable) {
  return { code, message, retryable };
}

function decide(failure, telemetry) {
  return toRecoveryDecision({
    failure,
    attempt: 1,
    firstFailureAtMs: 100,
    nowMs: 200,
    telemetry
  });
}

test('normalized provider network failures retain their code and retry', () => {
  const failure = runFailure('provider_network_error', 'fetch failed', true);
  const records = [];
  const decision = decide(failure, { record: (record) => records.push(record) });

  assert.equal(classifyFailure(failure).code, 'provider_network_error');
  assert.equal(decision.action, 'recover');
  assert.equal(records[0].failure.code, 'provider_network_error');
});

test('normalized provider request timeouts retain timeout retry semantics', () => {
  const failure = runFailure('provider_request_timeout', 'request timed out', true);
  const structured = classifyFailure(failure);
  const decision = decide(failure);

  assert.equal(structured.code, 'provider_request_timeout');
  assert.equal(structured.retryStrategy.conditions.has('timeout'), true);
  assert.equal(decision.action, 'recover');
});

test('HTTP 429 uses its dedicated retry strategy', () => {
  const structured = classifyFailure(runFailure('provider_http_error', 'Provider returned HTTP 429', true));
  assert.equal(structured.retryable, true);
  assert.equal(structured.retryStrategy.maxAttempts, 3);
  assert.equal(structured.retryStrategy.baseDelayMs, 2000);
  assert.equal(structured.retryStrategy.conditions.has('http_429'), true);
});

test('HTTP 503 retries as a server failure', () => {
  const structured = classifyFailure(runFailure('provider_http_error', 'Provider returned HTTP 503', true));
  assert.equal(structured.retryable, true);
  assert.equal(structured.retryStrategy.conditions.has('http_5xx'), true);
  assert.equal(decide(runFailure('provider_http_error', 'Provider returned HTTP 503', true)).action, 'recover');
});

test('HTTP 400 and 401 are terminal even when an input claims retryability', () => {
  for (const status of [400, 401]) {
    const failure = runFailure('provider_http_error', `Provider returned HTTP ${status}`, true);
    const structured = classifyFailure(failure);
    const decision = decide(failure);
    assert.equal(structured.retryable, false);
    assert.equal(structured.retryStrategy, undefined);
    assert.equal(decision.action, 'fail');
    assert.equal(decision.reason, 'non_transient');
  }
});

test('provider stream termination selects checkpoint recovery', () => {
  const failure = runFailure('provider_stream_terminated', 'stream ended early', true);
  const structured = classifyFailure(failure);
  const decision = decide(failure);

  assert.equal(structured.code, 'provider_stream_terminated');
  assert.equal(structured.retryStrategy.useCheckpointResume, true);
  assert.equal(decision.action, 'recover');
  assert.equal(decision.resumeFromCheckpoint, true);
});

test('context budget exhaustion fails without retry', () => {
  const decision = decide(runFailure('context_budget_exhausted', 'over budget', false));
  assert.equal(decision.action, 'fail');
  assert.equal(decision.finalFailure.code, 'context_budget_exhausted');
  assert.equal(decision.finalFailure.retryable, false);
});

test('non-Error values become standard non-retryable execution failures', () => {
  const structured = classifyFailure({ reason: 'unexpected value' });
  assert.equal(structured.code, 'provider_execution_failed');
  assert.equal(structured.retryable, false);
  assert.equal(decide({ reason: 'unexpected value' }).action, 'fail');
});
