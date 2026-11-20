import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ResourceActivity, MainResourceBudget, CapabilityRegistry, AgentActiveRunLifecycle,
  ResearchJobSession, ResearchBackgroundJobs, ToolResourceCoordinator, DatabasePool } =
  await importTypeScriptModule('tests/unit/fixtures/resource-budget-test-kit.ts', {
    platform: 'node', external: ['better-sqlite3'], tempDir: '.runtime/performance'
  });
const deferred = () => Promise.withResolvers();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const activity = new ResourceActivity(), states = [], policies = [], errors = [];
  let rss = 100, reclaimed = 0;
  const budget = new MainResourceBudget({ activity, mainRssBudgetBytes: 1000,
    sampleMainRss: () => rss, setProcessPolicy: value => policies.push(value),
    reclaimIdleDatabaseMemory: () => reclaimed++, onState: value => states.push(value), onError: error => errors.push(error),
    sampleIntervalMs: 60_000, idleDelayMs: 5, reclaimCooldownMs: 40 });
  budget.start();
  return { activity, budget, states, policies, errors, rss: value => { rss = value; budget.sample(); },
    reclaimed: () => reclaimed };
}

test('resource observer failures do not interrupt promised work or prevent balanced release', t => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const activity = new ResourceActivity(), transitions = [];
  activity.subscribe(() => { throw new Error('observer_failed'); });
  activity.subscribe(() => transitions.push(activity.busy));
  const release = activity.begin('research');
  assert.equal(activity.busy, true);
  release();
  release();
  assert.deepEqual(activity.snapshot(), { total: 0, counts: {} });
  assert.deepEqual(transitions, [true, false]);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(([code, error]) => code === 'resource_activity_observer_failed' && error.message === 'observer_failed'));
});

test('detached Research work keeps hidden host busy after its initiating capability returns', async () => {
  const f = fixture(), pending = deferred(), session = new ResearchJobSession('closed', f.activity);
  const jobs = new ResearchBackgroundJobs(session, () => assert.fail('job unexpectedly lost'));
  const registry = new CapabilityRegistry(f.activity);
  const descriptor = { name: 'start', version: '1', inputSchema: z.object({}).strict(), outputSchema: z.boolean() };
  registry.declare('test', descriptor);
  let signal;
  registry.register('test', descriptor, async () => {
    jobs.start('promised-work', {}, async value => { signal = value; await pending.promise; });
    return true;
  });
  try {
    await registry.invoke('start', {});
    f.budget.setHidden(true);
    assert.equal(f.budget.snapshot().state, 'background_busy');
    assert.deepEqual(f.activity.snapshot(), { total: 1, counts: { research: 1 } });
    await pause(15);
    assert.equal(f.reclaimed(), 0);
    assert.equal(signal.aborted, false);
    pending.resolve();
    await jobs.wait('promised-work');
    await pause(15);
    assert.equal(f.budget.snapshot().state, 'background_idle');
    assert.equal(f.activity.busy, false);
    assert.equal(f.reclaimed(), 1);
    await pause(10);
    assert.equal(f.reclaimed(), 1, 'do not shrink caches on every short idle transition');
    f.budget.setHidden(false);
    assert.equal(f.budget.snapshot().state, 'foreground_active');
  } finally {
    pending.resolve();
    f.budget.stop();
    await session.shutdown();
  }
});

test('Agent cancellation remains busy through pending cleanup; waiting-user metadata alone is idle', async () => {
  const f = fixture(), pending = deferred(), controller = new AbortController();
  const lifecycle = new AgentActiveRunLifecycle(() => assert.fail('unexpected rejection'), f.activity);
  lifecycle.activate({ runId: 'run', threadId: 'thread', request: {}, abortController: controller });
  lifecycle.trackPendingRun('run', pending.promise);
  f.budget.setHidden(true);
  try {
    const cancellation = lifecycle.cancel('run');
    assert.equal(controller.signal.aborted, true);
    await pause(15);
    assert.equal(f.budget.snapshot().state, 'background_busy');
    assert.equal(f.reclaimed(), 0);
    pending.resolve();
    await cancellation;
    await pause(15);
    assert.equal(f.activity.busy, false);
    assert.equal(f.reclaimed(), 1);
    lifecycle.activate({ runId: 'waiting', threadId: 'thread', request: {}, abortController: new AbortController() });
    lifecycle.replacePendingInterrupts('waiting', [{}]);
    assert.equal(lifecycle.findActiveRun('thread').status, 'waiting_user');
    assert.equal(f.budget.snapshot().state, 'background_idle');
    lifecycle.finish('waiting');
  } finally {
    pending.resolve();
    f.budget.stop();
    await lifecycle.shutdown();
  }
});

test('scheduled Agent work and failed Research/capability calls balance activity on every exit', async () => {
  const activity = new ResourceActivity(), pending = deferred(), failures = [];
  const lifecycle = new AgentActiveRunLifecycle(error => failures.push(error), activity);
  lifecycle.schedule(() => lifecycle.trackPendingRun('run', pending.promise));
  assert.equal(activity.busy, true);
  await pause(10);
  assert.equal(activity.snapshot().total, 1);
  pending.reject(new Error('provider_failed'));
  await lifecycle.shutdown();
  assert.equal(activity.busy, false);
  assert.equal(failures.length, 1);
  lifecycle.schedule(() => assert.fail('shutdown must remove task-created timer'));
  await lifecycle.shutdown();
  assert.equal(activity.busy, false);
  const session = new ResearchJobSession('closed', activity);
  await assert.rejects(session.run(async () => { throw new Error('research_failed'); }), /research_failed/);
  assert.equal(activity.busy, false);
  const registry = new CapabilityRegistry(activity), descriptor = {
    name: 'fail', version: '1', inputSchema: z.string(), outputSchema: z.boolean()
  };
  registry.declare('test', descriptor);
  registry.register('test', descriptor, async () => { throw new Error('handler_failed'); });
  await assert.rejects(registry.invoke('fail', 3));
  await assert.rejects(registry.invoke('fail', 'valid'), /handler_failed/);
  assert.deepEqual(activity.snapshot(), { total: 0, counts: {} });
  await session.shutdown();
});

test('pressure and background limits affect new process leases without aborting admitted work or losing fairness', async () => {
  const coordinator = new ToolResourceCoordinator();
  const request = (id, priority = 'user') => ({ projectId: id, priority, resourceClass: 'compute', gpu: false });
  const first = await coordinator.acquireResearchProcess(request('first'));
  const second = await coordinator.acquireResearchProcess(request('second'));
  coordinator.setResearchResourcePolicy({ background: false, pressure: true });
  let thirdAdmitted = false;
  const third = coordinator.acquireResearchProcess(request('third', 'background')).then(lease => { thirdAdmitted = true; return lease; });
  const controller = new AbortController();
  const cancelled = coordinator.acquireResearchProcess(request('cancelled'), controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /research_process_cancelled/);
  first.release();
  await pause(5);
  assert.equal(thirdAdmitted, false);
  assert.equal(coordinator.researchProcesses.active, 1);
  second.release();
  const thirdLease = await third;
  const fourth = coordinator.acquireResearchProcess(request('fourth'));
  await pause(5);
  assert.equal(coordinator.researchProcesses.active, 1);
  coordinator.setResearchResourcePolicy({ background: false, pressure: false });
  const fourthLease = await fourth;
  assert.equal(coordinator.researchProcesses.active, 2);
  assert.deepEqual(thirdLease.release(), thirdLease.release());
  fourthLease.release();
  assert.deepEqual(coordinator.researchProcesses, { active: 0, queued: 0, cleanupUnresolved: false });
});

test('RSS hysteresis, suspend/resume and shutdown do not cancel promised work or reclaim while busy', async () => {
  const f = fixture(), release = f.activity.begin('research');
  try {
    f.rss(1001);
    assert.equal(f.budget.snapshot().state, 'memory_pressure');
    f.rss(800);
    assert.equal(f.budget.snapshot().pressure, true);
    f.budget.suspend();
    release();
    await pause(15);
    assert.equal(f.reclaimed(), 0);
    f.budget.resume();
    await pause(15);
    assert.equal(f.reclaimed(), 1);
    f.rss(750);
    assert.equal(f.budget.snapshot().pressure, false);
    f.rss(NaN);
    assert.equal(f.errors.length, 1);
    assert.equal(f.budget.snapshot().pressure, false);
    f.budget.setHidden(true);
    f.budget.stop();
    await pause(50);
    assert.equal(f.reclaimed(), 1);
    assert.deepEqual(f.policies.at(-1), { background: false, pressure: false });
  } finally { release(); f.budget.stop(); }
});

test('SQLite reclamation preserves native transaction, statements, WAL and persisted rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roc-resource-budget-')), pool = new DatabasePool(root);
  try {
    const db = pool.getConnection('@roc/plugin-test'), core = pool.getCoreConnection();
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO sample(value) VALUES (?)'), read = db.prepare('SELECT * FROM sample');
    insert.run('before');
    const journal = db.pragma('journal_mode', { simple: true }), changes = db.prepare('SELECT total_changes()').pluck().get();
    db.transaction(() => {
      insert.run('inside');
      assert.deepEqual(pool.reclaimTransientMemory(), { reclaimedConnections: 1, skippedTransactions: 1 });
      assert.equal(read.all().length, 2);
    })();
    assert.deepEqual(pool.reclaimTransientMemory(), { reclaimedConnections: 2, skippedTransactions: 0 });
    assert.equal(db.pragma('journal_mode', { simple: true }), journal);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(), changes + 1);
    assert.deepEqual(read.all().map(row => row.value), ['before', 'inside']);
    assert.equal(core.open, true);
  } finally { pool.closeAll(); await rm(root, { recursive: true, force: true }); }
});
