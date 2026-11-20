import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());
const usage = { mode: 'monitored', sampleIntervalMs: 100, samples: 0, observedCpuTimeMs: null, peakResidentBytes: null };
const admission = { waitMs: 17, holdMs: 40 };
function request() {
  return {
    command: '/bin/true', args: ['--version'], cwd: '/private/tmp',
    readablePaths: ['/bin/true'], writablePaths: ['/private/tmp/probe'], environment: { PATH: '/usr/bin:/bin' },
    timeoutMs: 1000, maxOutputBytes: 4096,
    resourceLimits: { mode: 'monitored', cpuTimeMs: 500, maxResidentBytes: 4096 },
    admission: { projectId: 'probe-project', priority: 'user', resourceClass: 'utility' },
    allowGpuAcceleration: false, networkAccess: 'none',
    writeLimits: [{ path: '/private/tmp/probe', maxFileBytes: 1000, maxTotalBytes: 2000, maxFiles: 2, maxEntries: 4 }],
    signal: new AbortController().signal
  };
}

test('probe records original nonzero return, exact request policy and unknown observations without declaring inspection success', async () => {
  const input = request(), receipts = [];
  const actual = { exitCode: 9, stdout: 'probe refused', stderr: '', resourceUsage: usage, admission };
  const result = await api.runEnvironmentProbe('runtime_version', input, async dispatch => {
    assert.equal(dispatch, input); return actual;
  }, receipt => receipts.push(receipt));
  assert.equal(result, actual); assert.equal(receipts.length, 1);
  const receipt = receipts[0], { signal: _signal, ...dispatch } = input;
  assert.equal(receipt.requestHash, createHash('sha256').update(JSON.stringify(dispatch)).digest('hex'));
  assert.equal(receipt.outcome, 'returned'); assert.equal(receipt.exitCode, 9); assert.equal(receipt.error, null);
  assert.deepEqual(receipt.usage, usage); assert.deepEqual(receipt.admission, admission);
  assert.deepEqual(receipt.policy.writeLimits, input.writeLimits);
  assert.deepEqual(receipt.policy.resourceLimits, input.resourceLimits);
  assert.equal(receipt.policy.maxOutputBytes, input.maxOutputBytes);
  assert.equal('environment' in receipt, false);
});

test('probe preserves the exact runner error and admission/resource measurements once on rejection', async () => {
  const error = new api.ResearchProcessError('research_process_memory_limit', 'observed', 'stderr', usage);
  error.admission = admission;
  const receipts = [];
  await assert.rejects(api.runEnvironmentProbe('environment', request(), async () => { throw error; },
    receipt => receipts.push(receipt)), thrown => thrown === error);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, 'rejected'); assert.equal(receipts[0].exitCode, null);
  assert.equal(receipts[0].error, error.code); assert.deepEqual(receipts[0].usage, usage);
  assert.deepEqual(receipts[0].admission, admission);
});

test('queued abort remains an actual rejection with absent process observations and no fabricated dispatch', async () => {
  const controller = new AbortController(), input = { ...request(), signal: controller.signal };
  const error = new Error('research_process_aborted'); controller.abort(error);
  const receipts = [];
  await assert.rejects(api.runEnvironmentProbe('environment', input, async dispatch => {
    dispatch.signal.throwIfAborted();
  }, receipt => receipts.push(receipt)), thrown => thrown === error);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].error, error.message);
  assert.equal(receipts[0].usage, null); assert.equal(receipts[0].admission, null);
});
