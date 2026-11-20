import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ToolResourceCoordinator } = await importTypeScriptModule('src/main/services/deep-agent/tool-resource-coordinator.ts', { platform: 'node' });
const request = (projectId, overrides = {}) => ({ projectId, priority: 'user', resourceClass: 'compute', gpu: false, ...overrides });

test('global two and project one admit unrelated work past a blocked project and retain actual wait/hold observations', async () => {
  const coordinator = new ToolResourceCoordinator(), observations = [];
  const a = await coordinator.acquireResearchProcess(request('a'));
  let a2Admitted = false, cAdmitted = false;
  const a2 = coordinator.acquireResearchProcess(request('a'), undefined, observation => observations.push(observation))
    .then(lease => { a2Admitted = true; return lease; });
  const b = await coordinator.acquireResearchProcess(request('b'));
  const c = coordinator.acquireResearchProcess(request('c')).then(lease => { cAdmitted = true; return lease; });
  await nextTurn();
  assert.equal(a2Admitted, false); assert.equal(cAdmitted, false);
  assert.deepEqual(coordinator.researchProcesses, { active: 2, queued: 2, cleanupUnresolved: false });
  b.release(); const cLease = await c;
  assert.equal(a2Admitted, false); assert.equal(cAdmitted, true);
  a.release(); const a2Lease = await a2;
  cLease.release();
  const released = a2Lease.release();
  assert.strictEqual(a2Lease.release(), released);
  assert.ok(released.waitMs > 0); assert.ok(released.holdMs >= 0);
  assert.deepEqual(observations, [released]);
  assert.ok(released.conflictKinds.includes('research')); assert.ok(released.conflictKinds.includes('research_cpu'));
  assert.equal(coordinator.researchProcesses.active, 0);
});

test('single global parser and GPU slots allow a CPU experiment from another project', async () => {
  for (const restrictions of [{ resourceClass: 'parse' }, { gpu: true }]) {
    const coordinator = new ToolResourceCoordinator();
    const first = await coordinator.acquireResearchProcess(request('a', restrictions));
    let secondAdmitted = false;
    const second = coordinator.acquireResearchProcess(request('b', restrictions)).then(lease => { secondAdmitted = true; return lease; });
    const compute = await coordinator.acquireResearchProcess(request('c'));
    assert.equal(secondAdmitted, false);
    first.release(); const lease = await second;
    assert.equal(secondAdmitted, true);
    compute.release(); lease.release();
  }
});

test('the oldest eligible background task yields once to foreground and cannot be starved by more foreground arrivals', async () => {
  const coordinator = new ToolResourceCoordinator(), order = [];
  const blocker1 = await coordinator.acquireResearchProcess(request('active1'));
  const blocker2 = await coordinator.acquireResearchProcess(request('active2'));
  const queued = (name, priority) => coordinator.acquireResearchProcess(request(name, { priority }))
    .then(lease => { order.push(name); return lease; });
  const background = queued('background', 'background');
  const user1 = queued('user1', 'user'), user2 = queued('user2', 'user');
  blocker1.release(); const first = await user1;
  assert.deepEqual(order, ['user1']);
  const user3 = queued('user3', 'user');
  first.release(); const oldest = await background;
  assert.deepEqual(order, ['user1', 'background']);
  oldest.release(); const second = await user2;
  second.release(); const third = await user3;
  third.release(); blocker2.release();
  assert.deepEqual(order, ['user1', 'background', 'user2', 'user3']);
});

test('queued abort removes its request and mutable caller data cannot change an admitted project identity', async () => {
  const coordinator = new ToolResourceCoordinator(), controller = new AbortController(), observations = [];
  const caller = request('a');
  const first = await coordinator.acquireResearchProcess(caller);
  caller.projectId = 'b';
  const queuedRequest = request('a');
  const pending = coordinator.acquireResearchProcess(queuedRequest, controller.signal, observation => observations.push(observation));
  queuedRequest.gpu = true; queuedRequest.resourceClass = 'parse';
  assert.equal(coordinator.researchProcesses.queued, 1);
  controller.abort();
  await assert.rejects(pending, /research_process_cancelled/);
  assert.equal(coordinator.researchProcesses.queued, 0);
  assert.equal(observations[0].status, 'cancelled'); assert.equal(observations[0].holdMs, null);
  assert.deepEqual(observations[0].resourceKinds, ['research', 'research_cpu']);
  first.release();
  const next = await coordinator.acquireResearchProcess(request('a')); next.release();
});

test('unresolved native cleanup quarantines subsequent computation while diagnostic resource reads remain usable', async () => {
  const coordinator = new ToolResourceCoordinator();
  const active = await coordinator.acquireResearchProcess(request('a'));
  const pending = coordinator.acquireResearchProcess(request('a'));
  coordinator.quarantineResearchProcesses();
  await assert.rejects(pending, /research_process_cleanup_unresolved/);
  active.release();
  await assert.rejects(coordinator.acquireResearchProcess(request('b')), /research_process_cleanup_unresolved/);
  assert.deepEqual(coordinator.researchProcesses, { active: 0, queued: 0, cleanupUnresolved: true });
  const releaseRead = await coordinator.acquire([{ kind: 'research', key: 'diagnostics', access: 'read' }]);
  releaseRead();
});

test('admission rejects missing identities and bounds the pending queue without granting excess work', async () => {
  const coordinator = new ToolResourceCoordinator();
  await assert.rejects(coordinator.acquireResearchProcess({ ...request('a'), projectId: undefined }), /research_process_admission_invalid/);
  const active = await coordinator.acquireResearchProcess(request('a')), controller = new AbortController();
  const pending = Array.from({ length: 256 }, () => coordinator.acquireResearchProcess(request('a'), controller.signal));
  await assert.rejects(coordinator.acquireResearchProcess(request('a')), /research_process_admission_queue_limit/);
  const settled = Promise.allSettled(pending);
  controller.abort();
  assert.ok((await settled).every(result => result.status === 'rejected' && /research_process_cancelled/.test(result.reason.message)));
  active.release();
});
