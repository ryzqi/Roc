import {captureResearchArtifactVersions} from './fixtures/research-test-kit.mjs';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';
import { createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('pause waits cleanup and continuation creates a new execution with the same budget and deadline', async () => {
  const f = createResearchFixture(api, 'discovery');
  const cleanup = deferred();
  const signals = [];
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    async prepare() { return { providerId: 'fixture', modelId: 'fixture', async execute({ signal }) {
      signals.push(signal);
      return await new Promise(() => {});
    } }; }
  }, { complete: async () => {} }, { cancelOwned: async () => { await cleanup.promise; } });
  const controller = new api.ResearchTaskController(f.tasks, {
    stages: runtime, cancelChat: async () => {}, cancelJob: async () => {}
  });
  try {
    const budget = f.tasks.budgetForExecution('stage', f.run.id, f.project.id);
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const current = runtime.retry({ projectId: f.project.id, runId: f.run.id, requestId: 'pause-current' });
    await tick();
    const pause = controller.pause({ taskId: current.taskId, projectId: f.project.id });
    assert.equal(f.tasks.get(current.taskId, f.project.id).status, 'paused');
    assert.equal(signals[0].aborted, true);
    const request = { taskId: current.taskId, projectId: f.project.id, runId: current.id, requestId: 'continue-1' };
    assert.throws(() => controller.continueTask(request), /research_task_cleanup_pending/);
    cleanup.resolve();
    await pause;
    const next = controller.continueTask(request);
    assert.notEqual(next.id, current.id);
    assert.equal(next.taskId, current.taskId);
    assert.equal(next.retryOfRunId, current.id);
    assert.equal(f.repository.runs.get(current.id, f.project.id).status, 'interrupted');
    assert.equal(f.tasks.get(next.taskId, f.project.id).deadlineClock, 'continuous');
    assert.deepEqual(f.tasks.budgetForExecution('stage', next.id, f.project.id), budget);
    await tick();
    assert.equal(signals.length, 2);
    await controller.cancel({ taskId: next.taskId, projectId: f.project.id });
  } finally { cleanup.resolve(); await runtime.shutdown(); f.close(); }
});

test('continuation refuses unresolved effects from a linked chat run', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const timestamp = '2026-11-03T00:00:00.000Z';
    const execution = { ...f.tasks.requireExecution('stage', f.run.id, f.project.id), taskId: f.run.taskId, projectId: f.project.id,
      kind: 'chat', executionId: 'parent-chat', parentKind: null, parentExecutionId: null,
      associationSource: 'direct', manifestHash: 'a'.repeat(64), createdAt: timestamp };
    f.agentDb.prepare(`INSERT INTO research_task_executions
      (kind,execution_id,task_id,project_id,snapshot_json,created_at) VALUES ('chat','parent-chat',?,?,?,?)`)
      .run(f.run.taskId, f.project.id, JSON.stringify(execution), timestamp);
    f.agentDb.prepare(`INSERT INTO agent_tool_effects
      (run_id,thread_id,execution_path,checkpoint_id,tool_call_id,tool_name,input_hash,effect_class,reconcile_strategy,status,created_at,updated_at)
      VALUES ('parent-chat','thread','root','checkpoint','call','tool','hash','external_call','manual_confirmation','unknown',?,?)`)
      .run(timestamp, timestamp);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'interrupted', 'fixture', ['active']);
    assert.throws(() => f.tasks.continueWith(f.run.taskId, f.project.id, () => {}), /research_task_effect_unresolved/);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, 'interrupted');
    f.agentDb.prepare("UPDATE agent_tool_effects SET status='failed_final' WHERE run_id='parent-chat'").run();
    f.tasks.continueWith(f.run.taskId, f.project.id, () => {});
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, 'active');
  } finally { f.close(); }
});

test('cancelled task continuation is explicit and failed continuation rolls back task activation', async () => {
  const f = createResearchFixture(api, 'discovery');
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    async prepare() { throw new Error('research_fixture_failure'); }
  }, { complete: async () => {} }, {cancelOwned: async () => {}});
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture');
    f.tasks.setStatus(f.run.taskId, f.project.id, 'cancelled', 'fixture', ['active']);
    assert.throws(() => runtime.continueTask({
      taskId: f.run.taskId, projectId: f.project.id, runId: f.run.id, requestId: f.run.requestId
    }), /research_run_request_conflict/);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, 'cancelled');
    assert.throws(() => runtime.continueTask({
      taskId: 'foreign-task', projectId: f.project.id, runId: f.run.id, requestId: 'continue-1'
    }), /research_task_execution_conflict/);
    const next = runtime.continueTask({
      taskId: f.run.taskId, projectId: f.project.id, runId: f.run.id, requestId: 'continue-1'
    });
    await runtime.waitForIdle();
    assert.equal(next.taskId, f.run.taskId);
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'cancelled');
    const task = f.tasks.get(next.taskId, f.project.id);
    assert.equal(task.status, 'failed');
    assert.equal(task.statusReason, 'research_fixture_failure');
  } finally { await runtime.shutdown(); f.close(); }
});

test('existing stage pause and cancel preserve user intent in the task state', async () => {
  for (const action of ['pause', 'cancel']) {
    const f = createResearchFixture(api, 'discovery');
    const runtime = new api.ResearchStageRuntime(f.repository, {}, {prepare: async () => assert.fail('no model in control fixture')}, { complete: async () => {} }, {cancelOwned: async () => {}});
    try {
      runtime.attachTaskController(new api.ResearchTaskController(f.tasks, {
        stages: runtime, cancelChat: async () => {}, cancelJob: async () => {}
      }));
      if (action === 'pause') await runtime.transition({ projectId: f.project.id, expectedStage: 'discovery', action });
      else await runtime.cancel({ projectId: f.project.id, runId: f.run.id });
      assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, action === 'pause' ? 'paused' : 'cancelled');
    } finally { await runtime.shutdown(); f.close(); }
  }
});

test('real human gate leaves task awaiting approval and approval updates it without dispatching a model', async () => {
  const f = createResearchFixture(api, 'planning');
  const gate = api.createResearchHumanGate({ repository: f.repository });
  let attempts = 0;
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    async prepare() { return { providerId: 'fixture', modelId: 'fixture', async execute() {
      attempts += 1;
      return { output: { title: 'Plan', markdown: 'Plan for manual review', claims: [], sections: [], verdict: 'ready' },
        modelVersion: null };
    } }; }
  }, gate, {cancelOwned: async () => {}});
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const current = runtime.retry({ projectId: f.project.id, runId: f.run.id, requestId: 'approval-current' });
    await runtime.waitForIdle();
    assert.equal(f.repository.runs.get(current.id, f.project.id).status, 'completed');
    assert.equal(f.tasks.get(current.taskId, f.project.id).status, 'waiting_approval');
    assert.throws(() => f.tasks.budgetForExecution('stage', current.id, f.project.id), /research_task_not_active/);
    await gate.approve({ projectId: f.project.id, expectedStage: 'planning', action: 'approve', expectedArtifactVersions: captureResearchArtifactVersions(f.repository,f.project.id) });
    runtime.synchronizeTaskState(current.taskId, f.project.id);
    assert.equal(f.tasks.get(current.taskId, f.project.id).status, 'active');
    assert.equal(attempts, 1);
  } finally { await runtime.shutdown(); f.close(); }
});

test('cancellation during asynchronous human-gate verification cannot commit workflow completion', async () => {
  const f = createResearchFixture(api, 'figure');
  const entered = deferred();
  const verified = deferred();
  const gate = api.createResearchHumanGate({
    repository: f.repository, production: { async verifyStage() { entered.resolve(); await verified.promise; } }
  });
  const controller = new AbortController();
  try {
    const complete = gate.complete({ projectId: f.project.id, expectedStage: 'figure', action: 'complete' }, controller.signal);
    await entered.promise;
    controller.abort(new Error('research_task_cancelled'));
    verified.resolve();
    await assert.rejects(complete, /research_task_cancelled/);
    assert.equal(f.repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'figure').status, 'running');
  } finally { verified.resolve(); f.close(); }
});

test('startup interrupts active linked tasks, preserves cancellation and never restarts their executions', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const ledger = new api.RunBudgetLedger(f.agentDb);
    const budget = { ...api.createRunBudget({ contextBudgetTokens: 1000 }), maxTotalTokens: 10000 };
    f.agentDb.prepare('UPDATE research_task_budgets SET limits_json = ? WHERE task_id = ?')
      .run(JSON.stringify(budget), f.run.taskId);
    ledger.reserve(f.run.id, budget, { id: 'crashed-call', kind: 'model', tokens: 100, inputHash: 'hash', envelope: {} });
    ledger.reconcileStartup();
    f.repository.runs.recoverInterrupted();
    const task = f.tasks.get(f.run.taskId, f.project.id);
    assert.equal(task.status, 'interrupted');
    assert.equal(task.statusReason, 'research_task_interrupted_by_restart');
    assert.equal(f.agentDb.prepare('SELECT state,reserved_tokens FROM agent_budget_calls').get().state, 'unknown');
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'interrupted');
    assert.equal(f.repository.runs.list({ projectId: f.project.id, limit: 100 }).length, 1);
  } finally { f.close(); }
  const cancelled = createResearchFixture(api, 'discovery');
  try {
    cancelled.tasks.setStatus(cancelled.run.taskId, cancelled.project.id, 'cancelled', 'fixture', ['active']);
    cancelled.repository.runs.recoverInterrupted();
    assert.equal(cancelled.tasks.get(cancelled.run.taskId, cancelled.project.id).status, 'cancelled');
    assert.equal(cancelled.repository.runs.get(cancelled.run.id, cancelled.project.id).status, 'cancelled');
  } finally { cancelled.close(); }
});

test('v12 task migration preserves identity and status while requiring the new lifecycle contract', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    api.applyDatabaseMigrations(db, { dbName: 'agent', migrations: api.agentMigrations.filter(migration => migration.version <= 12) });
    const task = { schemaVersion: 1, id: 'existing-task', projectId: 'project', goal: 'Existing goal',
      rootAgentRunId: null, status: 'cancelled', budgetPolicyVersion: 1,
      createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T01:00:00.000Z' };
    db.prepare('INSERT INTO research_tasks (id,project_id,snapshot_json,created_at) VALUES (?,?,?,?)')
      .run(task.id, task.projectId, JSON.stringify(task), task.createdAt);
    api.applyDatabaseMigrations(db, { dbName: 'agent', migrations: api.agentMigrations, allowOffline: true });
    const migrated = new api.ResearchTaskRepository(db).get(task.id, task.projectId);
    assert.deepEqual(migrated, { ...task, schemaVersion: 2, statusReason: null, deadlineClock: 'continuous' });
    assert.equal(db.prepare('SELECT COUNT(*) FROM research_task_executions').pluck().get(), 0);
  } finally { db.close(); }
});
