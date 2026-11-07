import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {withResearchTestWorker,  createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

test('task diagnostics aggregate authoritative calls once and preserve unknown spend without exposing prompts', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const budget = { ...api.createRunBudget({ contextBudgetTokens: 1000 }), maxTotalTokens: 1000, maxCallTokens: 300 };
    f.agentDb.prepare('UPDATE research_task_budgets SET limits_json = ? WHERE task_id = ?')
      .run(JSON.stringify(budget), f.run.taskId);
    const child = { ...f.run, id: 'review-child', parentRunId: f.run.id, requestId: 'review-child', role: 'reviewer' };
    f.db.prepare(`INSERT INTO research_stage_runs
      (id,project_id,stage,request_id,parent_run_id,task_id,status,snapshot_json,context_json)
      SELECT ?,project_id,stage,?,?,task_id,status,?,context_json FROM research_stage_runs WHERE id = ?`)
      .run(child.id, child.requestId, f.run.id, JSON.stringify(child), f.run.id);
    f.tasks.linkStage({...child, executionSnapshot: {...child.executionSnapshot, nodeBinding: {kind: 'none'}}}, null);
    f.tasks.confirmExecution('stage', child.id, f.project.id, child.executionSnapshot.frozenInputs);
    const ledger = new api.RunBudgetLedger(f.agentDb);
    const reserve = (runId, id, tokens, cost) => ledger.reserve(runId, budget, {
      id, kind: 'model', tokens, inputHash: id, costMicrousd: cost, envelope: { messages: ['private-prompt-marker'] }
    });
    reserve(f.run.id, 'settled', 100, 60);
    ledger.settle(f.run.id, 'settled', 80, 'settled', undefined, {}, 40);
    reserve(child.id, 'unknown', 100, 70);
    ledger.settle(child.id, 'unknown', null, 'unknown');
    reserve(f.run.id, 'pending', 50, 50);
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, ledger, null, {source: async () => {throw new Error('fixture_resource_source_unused');}});
    const summary = diagnostics.get({ projectId: f.project.id, taskId: f.run.taskId });
    assert.deepEqual(summary.budget.tokens, { limit: 1000, settled: 80, unknown: 100, reserved: 50, remaining: 770 });
    assert.equal(summary.budget.calls.models.total, 3);
    assert.equal(summary.budget.cost.state, 'unknown');
    assert.equal(summary.budget.cost.settledMicrousd, 40);
    assert.equal(summary.budget.cost.reservedMicrousd, 120);
    assert.equal(summary.externalCost, 'unknown');
    assert.equal(summary.executions.length, 2);
    assert.equal(JSON.stringify(summary).includes('private-prompt-marker'), false);
    assert.equal(summary.executions[1].association.parentExecutionId, f.run.id);
    ledger.recordStopReason(child.id, 'run_cost_budget_exhausted');
    assert.equal(diagnostics.get({ projectId: f.project.id, taskId: f.run.taskId }).budget.stopReason, 'run_cost_budget_exhausted');
    f.repository.runs.terminate(f.run.id, f.project.id, 'interrupted', 'fixture');
    f.tasks.setStatus(f.run.taskId, f.project.id, 'interrupted', 'fixture', ['active']);
    assert.equal(diagnostics.get({ projectId: f.project.id, taskId: f.run.taskId }).continuationRunId, f.run.id);
    for (const reason of ['research_task_cleanup_pending', 'research_task_cleanup_failed']) {
      f.tasks.setStatus(f.run.taskId, f.project.id, 'interrupted', reason, ['interrupted']);
      assert.equal(diagnostics.get({ projectId: f.project.id, taskId: f.run.taskId }).continuationRunId, null);
    }
    assert.throws(() => diagnostics.get({ projectId: 'foreign', taskId: f.run.taskId }), /research_task_project_mismatch/);
  } finally { f.close(); }
});

test('chat task diagnostics enforce thread and project scope before returning task data', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const timestamp = '2026-11-03T00:00:00.000Z';
    f.agentDb.prepare(`INSERT INTO agent_threads
      (id,kind,title,goal,status,research_project_id,created_at,updated_at)
      VALUES ('thread','chat','Fixture','Research','active',?,?,?)`).run(f.project.id, timestamp, timestamp);
    f.agentDb.prepare(`INSERT INTO agent_runs
      (id,thread_id,run_number,user_input,status,started_at,ended_at,provider_id,model_id,enabled_capabilities_json,run_origin)
      VALUES ('chat','thread',1,'private-chat-prompt','completed',?,?,'provider','model','{}','chat')`).run(timestamp, timestamp);
    const execution = { ...f.tasks.requireExecution('stage',f.run.id,f.project.id), schemaVersion: 3, nodeBinding: {kind: 'none'}, taskId: f.run.taskId, projectId: f.project.id, kind: 'chat',
      executionId: 'chat', parentKind: null, parentExecutionId: null, associationSource: 'direct',
      manifestHash: 'a'.repeat(64), createdAt: timestamp };
    f.agentDb.prepare(`INSERT INTO research_task_executions
      (kind,execution_id,task_id,project_id,snapshot_json,created_at) VALUES ('chat','chat',?,?,?,?)`)
      .run(f.run.taskId, f.project.id, JSON.stringify(execution), timestamp);
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunBudgetLedger(f.agentDb), null, {source: async () => {throw new Error('fixture_resource_source_unused');}});
    const request = { projectId: f.project.id, threadId: 'thread', runId: 'chat' };
    const summary = diagnostics.forChat(request);
    assert.equal(summary.task.id, f.run.taskId);
    assert.equal(summary.executions[1].providerId, 'provider');
    assert.equal(JSON.stringify(summary).includes('private-chat-prompt'), false);
    for (const status of ['recovering', 'dispatch_pending', 'waiting_next_turn', 'waiting_user']) {
      f.agentDb.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').run(status, 'chat');
      assert.equal(diagnostics.forChat(request).executions[1].status, status);
    }
    assert.throws(() => diagnostics.forChat({ ...request, threadId: 'foreign-thread' }), /research_task_thread_mismatch/);
    assert.throws(() => diagnostics.forChat({ ...request, projectId: 'foreign-project' }), /research_task_project_mismatch/);
    assert.equal(diagnostics.forChat({ ...request, runId: 'unlinked' }), null);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:task-for-chat', [request]), [request]);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:task-for-chat', [{ ...request, parentRunId: 'forged' }]));
  } finally { f.close(); }
});

test('pausing approval and restoring it keeps the completed execution and original budget', async () => {
  const f = createResearchFixture(api, 'planning');
  const gate = api.createResearchHumanGate({ repository: f.repository });
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {prepare: async () => {throw new Error('unexpected_prepare');}}, gate, {cancelOwned: async () => {}});
  const controller = new api.ResearchTaskController(f.tasks, {
    stages: runtime, cancelChat: async () => {}, cancelJob: async () => {}
  });
  try {
    const budget = f.tasks.budgetForExecution('stage', f.run.id, f.project.id);
    withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {
      title: 'Plan', markdown: 'Review this plan', claims: [], sections: [], verdict: 'ready'
    }));
    await gate.complete({ projectId: f.project.id, expectedStage: 'planning', action: 'complete' });
    runtime.synchronizeTaskState(f.run.taskId, f.project.id);
    await controller.pause({ taskId: f.run.taskId, projectId: f.project.id });
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunBudgetLedger(f.agentDb), null, {source: async () => {throw new Error('fixture_resource_source_unused');}});
    assert.equal(diagnostics.get({ taskId: f.run.taskId, projectId: f.project.id }).canRestoreApproval, true);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'paused', 'research_task_cleanup_pending', ['paused']);
    assert.equal(diagnostics.get({ taskId: f.run.taskId, projectId: f.project.id }).canRestoreApproval, false);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'paused', 'research_task_paused', ['paused']);
    const originalStatus = f.repository.getProject(f.project.id).status;
    f.db.prepare("UPDATE research_projects SET status = 'archived' WHERE id = ?").run(f.project.id);
    assert.equal(diagnostics.get({ taskId: f.run.taskId, projectId: f.project.id }).canRestoreApproval, false);
    assert.throws(() => controller.restoreApproval({ taskId: f.run.taskId, projectId: f.project.id }), /research_project_archived/);
    f.db.prepare('UPDATE research_projects SET status = ? WHERE id = ?').run(originalStatus, f.project.id);
    const restored = controller.restoreApproval({ taskId: f.run.taskId, projectId: f.project.id });
    assert.equal(restored.status, 'waiting_approval');
    assert.equal(f.repository.runs.list({ projectId: f.project.id, limit: 100 }).length, 1);
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'completed');
    assert.equal(diagnostics.get({ taskId: f.run.taskId, projectId: f.project.id }).budget.deadlineAt, budget.deadlineAt);
    assert.throws(() => controller.restoreApproval({ taskId: f.run.taskId, projectId: f.project.id }), /research_task_status_conflict/);
  } finally { await runtime.shutdown(); f.close(); }
});
