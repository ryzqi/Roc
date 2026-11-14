import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resourceValues, summarizeResources } from '../lib/analysis.mjs';

test('retrieval quantiles aggregate actual request samples across trials', () => {
  const resources = summarizeResources([
    { retrievalLatenciesMs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 100], retrievalLatencyMs: 999 },
    { retrievalLatenciesMs: [10] },
    { retrievalLatencyMs: 11 },
    { diagnostics: { retrievalLatencyMs: 12 } }
  ]);
  assert.deepEqual(resources.retrievalLatencyMs, {
    observed: 13, unknown: 0, mean: 178 / 13, p50: 7, p95: 100
  });
  assert.equal(resourceValues(resources).retrievalP95Ms, 100);
});

test('missing or empty retrieval measurements cannot satisfy a latency gate', () => {
  for (const trial of [{}, { retrievalLatenciesMs: [] },
    { retrievalLatenciesMs: null, retrievalLatencyMs: 0 },
    { retrievalLatenciesMs: [null] }]) {
    const resources = summarizeResources([trial]);
    assert.equal(resources.retrievalLatencyMs.observed, 0);
    assert.equal(resources.retrievalLatencyMs.unknown, 1);
    assert.equal(resources.retrievalLatencyMs.p95, null);
    assert.equal(resourceValues(resources).retrievalP95Ms, null);
  }
  const partial = summarizeResources([
    { retrievalLatenciesMs: [10, 20] }, { retrievalLatenciesMs: [] }
  ]);
  assert.equal(partial.retrievalLatencyMs.observed, 2);
  assert.equal(partial.retrievalLatencyMs.unknown, 1);
  assert.equal(resourceValues(partial).retrievalP95Ms, null);
});
