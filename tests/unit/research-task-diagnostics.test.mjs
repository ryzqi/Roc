import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {withResearchTestWorker,  createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

test('task diagnostics aggregate authoritative calls once and preserve unknown token usage without exposing prompts', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const budget = { ...api.createRunModelConfig({ contextWindowTokens: 1000 }),  };
    const child = { ...f.run, id: 'review-child', parentRunId: f.run.id, requestId: 'review-child', role: 'reviewer' };
    f.db.prepare(`INSERT INTO research_stage_runs
      (id,project_id,stage,request_id,parent_run_id,task_id,status,snapshot_json,context_json)
      SELECT ?,project_id,stage,?,?,task_id,status,?,context_json FROM research_stage_runs WHERE id = ?`)
      .run(child.id, child.requestId, f.run.id, JSON.stringify(child), f.run.id);
    f.tasks.linkStage({...child, executionSnapshot: {...child.executionSnapshot, nodeBinding: {kind: 'none'}}}, null);
    f.tasks.confirmExecution('stage', child.id, f.project.id, child.executionSnapshot.frozenInputs);
    const ledger = new api.RunUsageLedger(f.agentDb);
    const reserve = (runId, id, tokens) => ledger.reserve(runId, budget, {
      id, kind: 'model', tokens, inputHash: id,  envelope: { messages: ['private-prompt-marker'] }
    });
    reserve(f.run.id, 'settled', 100);
    ledger.settle(f.run.id, 'settled', 80, 'settled');
    reserve(child.id, 'unknown', 100);
    ledger.settle(child.id, 'unknown', null, 'unknown');
    reserve(f.run.id, 'pending', 50);
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, ledger, null, {source: async () => {throw new Error('fixture_resource_source_unused');}});
    const summary = diagnostics.get({ projectId: f.project.id, taskId: f.run.taskId });
    assert.deepEqual(summary.usage.tokens, { settled: 80, unknown: 100, reserved: 50 });
    assert.equal(summary.usage.calls.models.total, 3);
    assert.equal(summary.executions.length, 2);
    assert.equal(JSON.stringify(summary).includes('private-prompt-marker'), false);
    assert.equal(summary.executions[1].association.parentExecutionId, f.run.id);
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
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunUsageLedger(f.agentDb), null, {source: async () => {throw new Error('fixture_resource_source_unused');}});
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

test('pausing approval and restoring it keeps the completed execution and original model config', async () => {
  const f = createResearchFixture(api, 'planning');
  const gate = api.createResearchHumanGate({ repository: f.repository });
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {prepare: async () => {throw new Error('unexpected_prepare');}}, gate, {cancelOwned: async () => {}});
  const controller = new api.ResearchTaskController(f.tasks, {
    stages: runtime, cancelChat: async () => {}, cancelJob: async () => {}
  });
  try {
    withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {
      title: 'Plan', markdown: 'Review this plan', claims: [], sections: [], verdict: 'ready'
    }));
    await gate.complete({ projectId: f.project.id, expectedStage: 'planning', action: 'complete' });
    runtime.synchronizeTaskState(f.run.taskId, f.project.id);
    await controller.pause({ taskId: f.run.taskId, projectId: f.project.id });
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunUsageLedger(f.agentDb), null, {source: async () => {throw new Error('fixture_resource_source_unused');}});
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
    assert.throws(() => f.tasks.modelConfigForExecution('stage', f.run.id, f.project.id), /research_task_not_active/);
    assert.equal(f.repository.runs.list({ projectId: f.project.id, limit: 100 }).length, 1);
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'completed');
    assert.throws(() => controller.restoreApproval({ taskId: f.run.taskId, projectId: f.project.id }), /research_task_status_conflict/);
  } finally { await runtime.shutdown(); f.close(); }
});

function savedOutputAfterRetry(f) {
  f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'first_attempt_failed');
  const next = f.repository.runs.retry({projectId: f.project.id, runId: f.run.id, requestId: 'saved-output'});
  return withResearchTestWorker(api, f.repository, next.id, f.project.id, id => {
    f.repository.runs.markRunning(id, f.project.id, {providerId: 'fixture', modelId: 'fixture'});
    return f.repository.runs.complete(id, f.project.id, {
      title: 'Saved plan', markdown: 'Review the saved output', claims: [], sections: [], verdict: 'ready'
    });
  });
}

test('continuation prefers the current saved output over a superseded failed attempt', async () => {
  const f = createResearchFixture(api, 'planning');
  let failGate = true;
  const actualGate = api.createResearchHumanGate({repository: f.repository});
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {prepare: async () => {throw new Error('unexpected_model');}}, {
    complete: async (...args) => {
      if (failGate) throw new Error('research_fixture_annotation_required');
      return actualGate.complete(...args);
    }
  }, {cancelOwned: async () => {}});
  try {
    const saved = savedOutputAfterRetry(f);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'failed', 'research_fixture_annotation_required', ['active']);
    const request = {taskId: f.run.taskId, projectId: f.project.id};
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunUsageLedger(f.agentDb), null, {source: async () => {throw new Error('unused');}});
    assert.equal(diagnostics.get(request).continuationRunId, saved.id);
    assert.throws(() => runtime.continueTask({...request, runId: f.run.id, requestId: 'obsolete-attempt'}), /research_run_not_current/);
    await assert.rejects(async () => runtime.continueTask({...request, runId: saved.id, requestId: 'revalidate-1'}), /research_fixture_annotation_required/);
    assert.equal(f.tasks.get(request.taskId, request.projectId).status, 'failed');
    assert.equal(f.repository.runs.get(saved.id, f.project.id).status, 'completed');
    failGate = false;
    const resumed = await runtime.continueTask({...request, runId: saved.id, requestId: 'revalidate-2'});
    assert.equal(resumed.id, saved.id);
    assert.equal(f.tasks.get(request.taskId, request.projectId).status, 'waiting_approval');
    assert.equal(f.repository.runs.list({projectId: f.project.id, limit: 100}).length, 2);
    assert.deepEqual(resumed.outputArtifactIds, saved.outputArtifactIds);
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'failed');
    assert.equal(diagnostics.get(request).continuationRunId, null);
  } finally {await runtime.shutdown(); f.close();}
});

test('saved-output continuation is cancelled before its asynchronous gate can commit', async () => {
  const f = createResearchFixture(api, 'planning');
  let entered;
  const started = new Promise(resolve => {entered = resolve;});
  let release;
  const barrier = new Promise(resolve => {release = resolve;});
  const actualGate = api.createResearchHumanGate({repository: f.repository});
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {prepare: async () => {throw new Error('unexpected_model');}}, {
    complete: async (request, signal) => {entered(); await barrier; return actualGate.complete(request, signal);}
  }, {cancelOwned: async () => {}});
  const controller = new api.ResearchTaskController(f.tasks, {stages: runtime, cancelChat: async () => {}, cancelJob: async () => {}});
  try {
    const saved = savedOutputAfterRetry(f);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'failed', 'research_fixture_annotation_required', ['active']);
    const request = {taskId: f.run.taskId, projectId: f.project.id};
    const pending = Promise.resolve().then(() => runtime.continueTask({...request, runId: saved.id, requestId: 'cancel-check'}));
    const rejected = assert.rejects(pending, /research_task_cancelled/);
    await started;
    const cancelled = controller.cancel(request);
    release();
    await Promise.all([cancelled, rejected]);
    assert.equal(f.tasks.get(request.taskId, request.projectId).status, 'cancelled');
    assert.equal(f.repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'planning').status, 'running');
    assert.equal(f.repository.runs.get(saved.id, f.project.id).status, 'completed');
  } finally {release(); await runtime.shutdown(); f.close();}
});


test('stale scientific input keeps task diagnostics readable and blocks continuation without losing history', () => {
  const f = createScientificReviewFixture(api);
  try {
    f.repository.runs.terminate(f.parent.id, f.project.id, 'interrupted', 'fixture_restart');
    f.tasks.setStatus(f.parent.taskId, f.project.id, 'interrupted', 'fixture_restart', ['active']);
    const request = {projectId: f.project.id, taskId: f.parent.taskId};
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunUsageLedger(f.agentDb), null,
      {source: async () => {throw new Error('unused');}});
    const before = diagnostics.get(request);
    assert.equal(before.continuationRunId, f.parent.id);
    f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
    assert.throws(() => f.repository.runs.assertInputsCurrent(f.repository.runs.get(f.parent.id, f.project.id)), /research_scientific_review_stale/);
    const after = diagnostics.get(request);
    assert.deepEqual(after.recoveryIssues, ['research_scientific_review_stale']);
    assert.equal(after.continuationRunId, null);
    assert.equal(after.canRestoreApproval, false);
    assert.deepEqual(after.executions, before.executions);
    assert.deepEqual(after.graph, before.graph);
    assert.equal(f.repository.runs.getContext(f.parent.id).scientificInput.evidence[0].referenceStatus, 'recorded');
  } finally {f.close();}
});
