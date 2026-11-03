import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';
import { createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());
const requestFor = f => ({ taskId: f.run.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 });

test('task events persist reservation, settlement and startup uncertainty with exact call identities', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const budget = api.createRunBudget({ contextBudgetTokens: 1000 });
    f.agentDb.prepare('UPDATE research_task_budgets SET limits_json = ? WHERE task_id = ?')
      .run(JSON.stringify(budget), f.run.taskId);
    const ledger = new api.RunBudgetLedger(f.agentDb);
    const reserve = id => ledger.reserve(f.run.id, budget, {
      id, kind: 'model', tokens: 100, inputHash: id, envelope: { messages: ['private-prompt-marker'] }
    });
    reserve('one');
    ledger.settle(f.run.id, 'one', 20, 'settled');
    reserve('two');
    ledger.reconcileStartup();
    const events = f.tasks.events(requestFor(f)).events;
    assert.deepEqual(events.map(event => event.eventType), [
      'task_created', 'execution_linked', 'call_reserved', 'call_settled', 'call_reserved', 'call_unknown'
    ]);
    const modelEvents = events.filter(event => event.callId !== null);
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
    assert.deepEqual(f.tasks.events(requestFor(f)).events, pausedEvents);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, 'paused');
    f.tasks.setStatus(f.run.taskId, f.project.id, 'active', null, ['paused']);
    const budget = api.createRunBudget({ contextBudgetTokens: 1000 });
    f.agentDb.prepare('UPDATE research_task_budgets SET limits_json = ? WHERE task_id = ?')
      .run(JSON.stringify(budget), f.run.taskId);
    const ledger = new api.RunBudgetLedger(f.agentDb);
    const reservation = { id: 'one', kind: 'model', tokens: 100, inputHash: 'one', envelope: {} };
    ledger.reserve(f.run.id, budget, reservation);
    ledger.settle(f.run.id, 'one', 20, 'settled');
    const saved = f.tasks.events(requestFor(f)).events;
    assert.throws(() => ledger.reserve(f.run.id, budget, reservation), /run_budget_call_already_reserved/);
    assert.throws(() => ledger.settle(f.run.id, 'one', 1, 'settled'), /run_budget_settlement_invalid/);
    assert.deepEqual(f.tasks.events(requestFor(f)).events, saved);
  } finally { f.close(); }
});

test('task event pagination and IPC preserve scope and monotonically ordered sequences', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    f.tasks.cancel(f.run.taskId, f.project.id);
    const request = { ...requestFor(f), limit: 1 };
    const first = f.tasks.events(request);
    assert.equal(first.hasMore, true);
    const second = f.tasks.events({ ...request, afterSequence: first.nextSequence });
    assert.ok(second.nextSequence > first.nextSequence);
    const full = f.tasks.events(requestFor(f));
    const empty = f.tasks.events({ ...request, afterSequence: full.nextSequence });
    assert.deepEqual(empty, { events: [], nextSequence: full.nextSequence, hasMore: false });
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
      status: 'active', statusReason: null, deadlineClock: 'continuous', budgetPolicyVersion: 1,
      createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' };
    db.prepare('INSERT INTO research_tasks(id,project_id,status,snapshot_json,created_at) VALUES (?,?,?,?,?)')
      .run(task.id, task.projectId, task.status, JSON.stringify(task), task.createdAt);
    api.applyDatabaseMigrations(db, { dbName: 'agent', migrations: api.agentMigrations });
    const tasks = new api.ResearchTaskRepository(db);
    const request = { taskId: task.id, projectId: task.projectId, afterSequence: 0, limit: 200 };
    assert.deepEqual(tasks.get(task.id, task.projectId), task);
    assert.deepEqual(tasks.events(request).events, []);
    tasks.cancel(task.id, task.projectId);
    const event = tasks.events(request).events[0];
    assert.equal(event.eventType, 'task_status');
    assert.equal(event.state, 'cancelled');
  } finally { db.close(); }
});
