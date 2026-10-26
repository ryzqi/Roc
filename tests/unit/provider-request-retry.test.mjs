import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const bundleDirectory = await mkdtemp(`${repositoryRoot}/.roc-provider-retry-`);
const retryModule = await importTypeScriptModule('src/main/services/provider-request-retry.ts', {
  platform: 'node',
  external: ['p-retry'],
  tempDir: bundleDirectory
});
const { ProviderRuntimeService } = await importTypeScriptModule('src/main/services/provider-runtime-service.ts', {
  platform: 'node',
  external: ['p-retry'],
  tempDir: bundleDirectory
});
await rm(bundleDirectory, { recursive: true, force: true });

const {
  classifyProviderRequestFailure,
  executeWithProviderRequestRetry,
  isRetryableProviderHttpStatus,
  ProviderStreamIdleError,
  ProviderStreamTerminatedError
} = retryModule;

function createMetrics() {
  const counters = [];
  const histograms = [];
  return {
    counters,
    histograms,
    service: {
      incrementCounter(name, labels = {}) {
        counters.push({ name, labels: { ...labels } });
      },
      recordHistogram(name, value, labels = {}) {
        histograms.push({ name, value, labels: { ...labels } });
      }
    }
  };
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('provider retry classification keeps transient and terminal error categories', () => {
  for (const status of [408, 425, 429, 500, 503, 599]) {
    assert.equal(isRetryableProviderHttpStatus(status), true);
    assert.deepEqual(classifyProviderRequestFailure(httpError(status)), { kind: 'http', status });
  }
  for (const status of [400, 401, 404]) {
    assert.equal(isRetryableProviderHttpStatus(status), false);
    assert.deepEqual(classifyProviderRequestFailure(httpError(status)), { kind: 'http', status });
  }
  assert.deepEqual(classifyProviderRequestFailure(new TypeError('request timed out')), { kind: 'timeout' });
  assert.deepEqual(classifyProviderRequestFailure(new TypeError('fetch failed')), { kind: 'network' });
  assert.deepEqual(classifyProviderRequestFailure(new DOMException('cancelled', 'AbortError')), { kind: 'abort' });
  assert.deepEqual(classifyProviderRequestFailure(new ProviderStreamIdleError()), { kind: 'stream_idle' });
  assert.deepEqual(classifyProviderRequestFailure(new ProviderStreamTerminatedError()), { kind: 'stream_terminated' });
  assert.deepEqual(classifyProviderRequestFailure(new Error('unexpected failure')), { kind: 'other' });
});

test('provider retries use four total attempts with exact 1/2/4 second backoff and per-attempt metrics', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const metrics = createMetrics();
  const failures = [httpError(503), new TypeError('fetch failed'), new TypeError('request timed out')];
  let calls = 0;
  const resultPromise = executeWithProviderRequestRetry(
    async () => {
      calls += 1;
      if (calls <= failures.length) throw failures[calls - 1];
      return 'provider response';
    },
    { labels: { providerId: 'fixture' }, metricsService: metrics.service }
  );

  await nextImmediate();
  assert.equal(calls, 1);
  for (const [delayMs, expectedCalls] of [[1_000, 2], [2_000, 3], [4_000, 4]]) {
    t.mock.timers.tick(delayMs - 1);
    await nextImmediate();
    assert.equal(calls, expectedCalls - 1);
    t.mock.timers.tick(1);
    await nextImmediate();
    assert.equal(calls, expectedCalls);
  }

  assert.equal(await resultPromise, 'provider response');
  const totalAttempts = metrics.counters.filter(({ name }) => name === 'provider.request.total');
  const failedAttempts = metrics.counters.filter(({ name }) => name === 'provider.request.errors');
  assert.deepEqual(totalAttempts.map(({ labels }) => labels.attempt), ['1', '2', '3', '4']);
  assert.deepEqual(failedAttempts.map(({ labels }) => labels.kind), ['http', 'network', 'timeout']);
  assert.equal(metrics.histograms.length, 1);
  assert.equal(metrics.histograms[0].name, 'provider.request.duration_ms');
  assert.equal(metrics.histograms[0].labels.attempt, '4');
});

test('provider probes retry empty responses four times and record every terminal failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const metrics = createMetrics();
  const service = new ProviderRuntimeService(
    {
      getDefaultModelState: () => ({ status: 'unconfigured', providerId: null }),
      getProviders: () => ({
        providers: [{
          id: 'fixture-provider',
          type: 'openai_compatible',
          enabled: true,
          models: [{ id: 'fixture-model', enabled: true }]
        }]
      })
    },
    {},
    metrics.service
  );
  service.setDeterministicResponse({ content: ' ', finishReason: 'stop' });
  const resultPromise = service.testProvider({ providerId: 'fixture-provider', modelId: 'fixture-model' });

  await nextImmediate();
  const totalAttempts = () => metrics.counters.filter(({ name }) => name === 'provider.request.total');
  assert.equal(totalAttempts().length, 1);
  for (const [delayMs, expectedCalls] of [[1_000, 2], [2_000, 3], [4_000, 4]]) {
    t.mock.timers.tick(delayMs - 1);
    await nextImmediate();
    assert.equal(totalAttempts().length, expectedCalls - 1);
    t.mock.timers.tick(1);
    await nextImmediate();
    assert.equal(totalAttempts().length, expectedCalls);
  }

  const result = await resultPromise;
  assert.equal(result.status, 'invalid');
  assert.deepEqual(
    metrics.counters.filter(({ name }) => name === 'provider.request.errors').map(({ labels }) => labels.kind),
    ['empty_response', 'empty_response', 'empty_response', 'empty_response']
  );
  assert.equal(metrics.histograms.length, 0);
});

test('pre-aborted and backoff-aborted requests keep AbortError semantics and stop attempts', async (t) => {
  const preAborted = new AbortController();
  preAborted.abort();
  const preAbortedMetrics = createMetrics();
  let preAbortedCalls = 0;
  await assert.rejects(
    executeWithProviderRequestRetry(async () => {
      preAbortedCalls += 1;
    }, { signal: preAborted.signal, metricsService: preAbortedMetrics.service }),
    (error) => error.name === 'AbortError'
  );
  assert.equal(preAbortedCalls, 0);
  assert.equal(preAbortedMetrics.counters.length, 0);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const metrics = createMetrics();
  let calls = 0;
  const retryPromise = executeWithProviderRequestRetry(
    async () => {
      calls += 1;
      throw httpError(503);
    },
    { signal: controller.signal, metricsService: metrics.service }
  );
  await nextImmediate();
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(retryPromise, (error) => error.name === 'AbortError');
  t.mock.timers.tick(10_000);
  await nextImmediate();
  assert.equal(calls, 1);
  assert.equal(metrics.counters.filter(({ name }) => name === 'provider.request.total').length, 1);
});

test('stream terminal errors after partial output are not automatically retried', async () => {
  for (const error of [new ProviderStreamIdleError(), new ProviderStreamTerminatedError()]) {
    const output = [];
    let calls = 0;
    await assert.rejects(
      executeWithProviderRequestRetry(async () => {
        calls += 1;
        output.push('partial output');
        throw error;
      }),
      (actualError) => actualError === error
    );
    assert.equal(calls, 1);
    assert.deepEqual(output, ['partial output']);
  }
});

test('non-Error rejections keep their original value', async () => {
  const rejection = 'provider rejected with a primitive';
  let actual;
  try {
    await executeWithProviderRequestRetry(async () => {
      throw rejection;
    });
  } catch (error) {
    actual = error;
  }
  assert.equal(actual, rejection);
});
