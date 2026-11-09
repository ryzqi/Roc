import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';
import { createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());
const requestFor = f => ({ taskId: f.run.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 });

test('project task listing uses stable creation cursors despite identical timestamps and status updates', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const second = f.tasks.linkStage({ ...f.run, executionSnapshot: {...f.run.executionSnapshot, nodeBinding: {kind: 'none'}}, id: 'second-stage', taskId: null, requestId: 'second-stage' }, null);
    const third = f.tasks.linkStage({ ...f.run, executionSnapshot: {...f.run.executionSnapshot, nodeBinding: {kind: 'none'}}, id: 'third-stage', taskId: null, requestId: 'third-stage' }, null);
    const request = { projectId: f.project.id, afterTaskId: null, limit: 2 };
    const firstPage = f.tasks.list(request);
    assert.deepEqual(firstPage.tasks.map(task => task.id), [third.taskId, second.taskId]);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextTaskId, second.taskId);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'paused', 'fixture', ['active']);
    const secondPage = f.tasks.list({ ...request, afterTaskId: firstPage.nextTaskId });
    assert.deepEqual(secondPage.tasks.map(task => task.id), [f.run.taskId]);
    assert.equal(secondPage.tasks[0].status, 'paused');
    assert.equal(secondPage.hasMore, false);
    assert.deepEqual(f.tasks.list({ ...request, afterTaskId: secondPage.nextTaskId }).tasks, []);
    assert.throws(() => f.tasks.list({ ...request, afterTaskId: 'absent' }), /research_task_not_found/);
    assert.deepEqual(f.tasks.list({ ...request, projectId: 'foreign' }).tasks, []);
    assert.throws(() => f.tasks.list({ ...request, projectId: 'foreign', afterTaskId: f.run.taskId }), /research_task_project_mismatch/);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:task-list', [request]), [request]);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:task-list', [{ ...request, limit: 101 }]));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:task-list', [{ ...request, ownerRunId: 'forged' }]));
  } finally { f.close(); }
});

test('task events persist reservation, settlement and startup uncertainty with exact call identities', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const budget = api.createRunModelConfig({ contextWindowTokens: 1000 });
    const ledger = new api.RunUsageLedger(f.agentDb);
    const reserve = id => ledger.reserve(f.run.id, budget, {
      id, kind: 'model', tokens: 100, inputHash: id, envelope: { messages: ['private-prompt-marker'] }
    });
    reserve('one');
    ledger.settle(f.run.id, 'one', 20, 'settled');
    reserve('two');
    ledger.reconcileStartup();
    const events = f.tasks.events(requestFor(f)).events;
    assert.deepEqual(events.map(event => event.eventType), [
      'task_created', 'execution_linked', 'node_claimed', 'call_reserved', 'call_settled', 'call_reserved', 'call_unknown'
    ]);
    const modelEvents = events.map(event => event.payload).filter(event => event.callId !== null);
    assert.deepEqual(modelEvents.map(event => [event.callId, event.state]), [
      ['one', 'reserved'], ['one', 'settled'], ['two', 'reserved'], ['two', 'unknown']
    ]);
    assert.ok(modelEvents.every(event => event.executionId === f.run.id && event.executionKind === 'stage'));
    assert.equal(JSON.stringify(events).includes('private-prompt-marker'), false);
    assert.deepEqual(new api.ResearchTaskRepository(f.agentDb).events(requestFor(f)).events, events);
  } finally { f.close(); }
});

test('rolled-back activation and denied or repeated calls produce no successful-looking task events', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    f.tasks.setStatus(f.run.taskId, f.project.id, 'paused', 'research_task_paused', ['active']);
    const pausedEvents = f.tasks.events(requestFor(f)).events;
    assert.throws(() => f.tasks.continueWith(f.run.taskId, f.project.id, () => { throw new Error('fixture_rollback'); }), /fixture_rollback/);
    const resumedEvents = f.tasks.events(requestFor(f)).events;
    assert.deepEqual(resumedEvents.slice(0,pausedEvents.length), pausedEvents);
    assert.deepEqual(resumedEvents.slice(pausedEvents.length).map(event=>event.payload.state), ['active','paused']);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, 'paused');
    f.tasks.setStatus(f.run.taskId, f.project.id, 'active', null, ['paused']);
    const budget = api.createRunModelConfig({ contextWindowTokens: 1000 });
    const ledger = new api.RunUsageLedger(f.agentDb);
    const reservation = { id: 'one', kind: 'model', tokens: 100, inputHash: 'one', envelope: {} };
    ledger.reserve(f.run.id, budget, reservation);
    ledger.settle(f.run.id, 'one', 20, 'settled');
    const saved = f.tasks.events(requestFor(f)).events;
    ledger.settle(f.run.id, 'one', 20, 'settled');
    assert.throws(() => ledger.reserve(f.run.id, budget, reservation), /run_call_call_already_reserved/);
    assert.throws(() => ledger.settle(f.run.id, 'one', 1, 'settled'), /run_call_settlement_invalid/);
    assert.deepEqual(f.tasks.events(requestFor(f)).events, saved);
  } finally { f.close(); }
});

test('task event pagination and IPC preserve scope and monotonically ordered sequences', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    f.tasks.setStatus(f.run.taskId, f.project.id, 'cancelled', 'fixture', ['active']);
    const request = { ...requestFor(f), limit: 1 };
    const first = f.tasks.events(request);
    assert.equal(first.hasMore, true);
    const second = f.tasks.events({ ...request, afterSequence: first.nextSequence });
    assert.ok(second.nextSequence > first.nextSequence);
    const full = f.tasks.events(requestFor(f));
    const empty = f.tasks.events({ ...request, afterSequence: full.nextSequence });
    assert.deepEqual(empty, { events: [], nextSequence: full.nextSequence, hasMore: false, gap: null });
    assert.throws(() => f.tasks.events({ ...request, projectId: 'foreign' }), /research_task_project_mismatch/);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:task-events', [request]), [request]);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:task-events', [{ ...request, afterSequence: -1 }]));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:task-events', [{ ...request, limit: 201 }]));
  } finally { f.close(); }
});

test('v13 migration retains tasks without fabricating historical event rows', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    api.applyDatabaseMigrations(db, { dbName: 'agent', migrations: api.agentMigrations.filter(migration => migration.version <= 13) });
    const task = { schemaVersion: 2, id: 'existing', projectId: 'project', goal: 'Existing work', rootAgentRunId: null,
      status: 'active', statusReason: null,
      createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' };
    db.prepare('INSERT INTO research_tasks(id,project_id,status,snapshot_json,created_at) VALUES (?,?,?,?,?)')
      .run(task.id, task.projectId, task.status, JSON.stringify(task), task.createdAt);
    api.applyDatabaseMigrations(db, { dbName: 'agent', migrations: api.agentMigrations, allowOffline:true });
    const tasks = new api.ResearchTaskRepository(db);
    assert.deepEqual(JSON.parse(db.prepare('SELECT snapshot_json FROM research_tasks WHERE id=?').pluck().get(task.id)), task);
    assert.equal(db.prepare('SELECT COUNT(*) FROM research_task_events WHERE task_id=?').pluck().get(task.id), 0);
    assert.throws(() => tasks.get(task.id, task.projectId), /expected 3/); // Offline conversion, not DDL, owns historical snapshots.
  } finally { db.close(); }
});
