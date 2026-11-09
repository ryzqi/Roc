import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('task cancellation fences new dispatch, awaits owned cleanup and leaves unrelated stages running', async () => {
  const f = createResearchFixture(api, 'discovery');
  const budget = { ...f.tasks.modelConfigForExecution('stage', f.run.id, f.project.id),
    };
  const cleanup = deferred();
  const calls = new Map();
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    async prepare() {
      return { providerId: 'fixture', modelId: 'fixture', async execute({ run, signal }) {
        const output = deferred();
        calls.set(run.id, { signal, output });
        return await output.promise;
      } };
    }
  }, { complete: async () => { throw new Error('late_gate_must_not_execute'); } }, {
    cancelOwned: async (projectId) => { if (projectId === f.project.id) await cleanup.promise; }
  }, undefined, 2);
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const current = runtime.retry({ projectId: f.project.id, runId: f.run.id, requestId: 'current' });
    const otherProject = f.repository.createProject({ title: 'Unrelated', description: '', workspacePath: '/tmp/other-task' });
    const seeded = f.repository.runs.begin({
      projectId: otherProject.id, expectedStage: 'discovery', instruction: 'Independent stage', requestId: 'other-seed'
    });
    f.repository.runs.terminate(seeded.id, otherProject.id, 'failed', 'fixture');
    const other = runtime.retry({projectId:otherProject.id,runId:seeded.id,requestId:'other'});
    await tick();
    assert.equal(calls.size, 2);
    const child = { ...f.repository.runs.get(current.id, f.project.id), id: 'review-child',
      parentRunId: current.id, retryOfRunId: null, requestId: 'review-child', role: 'reviewer' };
    f.db.prepare(`INSERT INTO research_stage_runs
      (id,project_id,stage,request_id,parent_run_id,task_id,status,snapshot_json,context_json)
      SELECT ?,project_id,stage,?,?,task_id,status,?,context_json FROM research_stage_runs WHERE id = ?`)
      .run(child.id, child.requestId, current.id, JSON.stringify(child), current.id);
    f.tasks.linkStage({...child, executionSnapshot: {...child.executionSnapshot, nodeBinding: {kind: 'none'}}}, null);
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: runtime, cancelChat: async () => { throw new Error('no_chat_expected'); },
      cancelJob: async () => { throw new Error('no_job_expected'); }
    });
    runtime.attachTaskController(controller);
    const request = { taskId: current.taskId, projectId: f.project.id };
    let finished = false;
    const cancelled = runtime.cancel({ projectId: f.project.id, runId: current.id }).then(run => { finished = true; return run; });
    assert.equal(f.tasks.get(current.taskId, f.project.id).status, 'cancelled');
    assert.throws(() => f.tasks.modelConfigForExecution('stage', current.id, f.project.id), /research_task_not_active/);
    assert.throws(() => new api.RunUsageLedger(f.agentDb).reserve(current.id, budget, {
      id: 'late', kind: 'model', tokens: 1, inputHash: 'late', envelope: {}
    }), /research_task_not_active/);
    assert.equal(calls.get(current.id).signal.aborted, true);
    assert.equal(calls.get(other.id).signal.aborted, false);
    await tick();
    assert.equal(finished, false);
    cleanup.resolve();
    assert.equal((await cancelled).status, 'cancelled');
    assert.equal(f.repository.runs.get(current.id, f.project.id).status, 'cancelled');
    assert.equal(f.repository.runs.get(child.id, f.project.id).status, 'cancelled');
    assert.equal(f.repository.runs.get(other.id, otherProject.id).status, 'running');
    calls.get(current.id).output.resolve({
      output: { title: 'Late', markdown: 'Late output', claims: [], sections: [], verdict: 'ready' }, modelVersion: null
    });
    await tick();
    assert.deepEqual(f.repository.runs.get(current.id, f.project.id).outputArtifactIds, []);
    assert.throws(() => runtime.retry({ ...request, runId: current.id, requestId: 'cancelled-retry' }), /research_task_not_active/);
    assert.equal(f.repository.runs.list({ projectId: f.project.id, limit: 100 }).some(run => run.requestId === 'cancelled-retry'), false);
    const otherCancelled = runtime.cancel({ projectId: otherProject.id, runId: other.id });
    calls.get(other.id).output.resolve({
      output: { title: 'Late', markdown: 'Late output', claims: [], sections: [], verdict: 'ready' }, modelVersion: null
    });
    await otherCancelled;
  } finally { cleanup.resolve(); await runtime.shutdown(); f.close(); }
});

test('task cancellation shares stage-owned cleanup across concurrent cancellation requests', async () => {
  const f = createResearchFixture(api, 'discovery');
  const stageCleanup = deferred();
  const cancelledJobs = [];
  let stages = 0;
  try {
    for (const kind of ['experiment', 'figure', 'export']) {
      f.tasks.linkOwned({ kind, executionId: `${kind}-1`, projectId: f.project.id, ownerRunId: f.run.id,
        goal: 'Owned work', snapshot: { kind } });
    }
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: { async cancelTask(taskId, projectId) {
        assert.equal(f.tasks.get(taskId, projectId).status, 'cancelled');
        stages += 1;
        await stageCleanup.promise;
      } },
      cancelChat: async () => { throw new Error('no_chat_expected'); },
      cancelJob: async (kind, projectId, id) => {
        assert.equal(f.tasks.get(f.run.taskId, projectId).status, 'cancelled');
        cancelledJobs.push([kind, id]);
      }
    });
    const request = { taskId: f.run.taskId, projectId: f.project.id };
    const first = controller.cancel(request);
    const second = controller.cancel(request);
    assert.equal(first, second);
    assert.equal(stages, 1);
    assert.deepEqual(cancelledJobs, []);
    stageCleanup.resolve();
    await first;
    assert.throws(() => controller.cancel({ ...request, projectId: 'another-project' }), /research_task_project_mismatch/);
    assert.equal(stages, 1);
    assert.throws(() => f.tasks.linkOwned({ kind: 'figure', executionId: 'late-figure', projectId: f.project.id,
      ownerRunId: f.run.id, goal: 'Late work', snapshot: {} }), /research_task_not_active/);
  } finally { stageCleanup.resolve(); f.close(); }
});

test('cleanup failures are reported after other jobs finish and cancelled identity survives restart', async () => {
  const f = createResearchFixture(api, 'discovery');
  const budget = { ...f.tasks.modelConfigForExecution('stage', f.run.id, f.project.id),
    };
  let completed = false;
  try {
    const execution = f.tasks.linkOwned({ kind: 'figure', executionId: 'figure-1', projectId: f.project.id, ownerRunId: null,
      goal: 'Owned work', snapshot: {} });
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: { async cancelTask() { throw new Error('fixture_stage_cleanup_failure'); } },
      cancelChat: async () => {},
      cancelJob: async () => { await tick(); completed = true; }
    });
    await assert.rejects(controller.cancel({ taskId: execution.taskId, projectId: f.project.id }), error => {
      assert.equal(error.message, 'research_task_cleanup_failed');
      assert.equal(error.errors[0].message, 'fixture_stage_cleanup_failure');
      return true;
    });
    assert.equal(completed, true);
    const restarted = new api.ResearchTaskRepository(f.agentDb);
    assert.equal(restarted.get(execution.taskId, f.project.id).status, 'cancelled');
    assert.equal(restarted.get(execution.taskId, f.project.id).statusReason, 'research_task_cleanup_failed');
    assert.throws(() => restarted.continueWith(execution.taskId, f.project.id, () => {}), /research_task_cleanup_unconfirmed/);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'cancelled', 'fixture', ['active']);
    const ledger = new api.RunUsageLedger(f.agentDb);
    assert.throws(() => ledger.reserve(f.run.id, budget, {
      id: 'late', kind: 'model', tokens: 1, inputHash: 'late', envelope: {}
    }), /research_task_not_active/);
  } finally { f.close(); }
});

test('cancellation waits for an already running pause cleanup', async () => {
  const f = createResearchFixture(api, 'discovery');
  const pause = deferred();
  try {
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: { pauseTask: () => pause.promise, cancelTask: async () => {} },
      cancelChat: async () => {}, cancelJob: async () => {}
    });
    const request = { taskId: f.run.taskId, projectId: f.project.id };
    const pausing = controller.pause(request);
    let finished = false;
    const cancellation = controller.cancel(request).then(task => { finished = true; return task; });
    await tick();
    assert.equal(finished, false);
    assert.equal(f.tasks.get(request.taskId, request.projectId).statusReason, 'research_task_cleanup_pending');
    pause.resolve();
    await pausing;
    assert.equal((await cancellation).statusReason, 'research_task_cancelled');
  } finally { pause.resolve(); f.close(); }
});

test('stage cleanup waits for other effects after a synchronous effect failure', async () => {
  const f = createResearchFixture(api, 'discovery');
  const pending = deferred();
  try {
    const child = { ...f.repository.runs.get(f.run.id, f.project.id), id: 'cleanup-child',
      parentRunId: f.run.id, retryOfRunId: null, requestId: 'cleanup-child', role: 'reviewer' };
    f.db.prepare(`INSERT INTO research_stage_runs
      (id,project_id,stage,request_id,parent_run_id,task_id,status,snapshot_json,context_json)
      SELECT ?,project_id,stage,?,?,task_id,status,?,context_json FROM research_stage_runs WHERE id = ?`)
      .run(child.id, child.requestId, f.run.id, JSON.stringify(child), f.run.id);
    f.tasks.linkStage({...child, executionSnapshot: {...child.executionSnapshot, nodeBinding: {kind: 'none'}}}, null);
    const seen = [];
    const runtime = new api.ResearchStageRuntime(f.repository, {}, {prepare: async () => {throw new Error('unexpected_prepare');}}, { complete: async () => {} }, {
      cancelOwned(_projectId, runId) {
        seen.push(runId);
        if (runId === f.run.id) throw new Error('sync_effect_failure');
        return pending.promise;
      }
    });
    let settled = false;
    const result = runtime.cancelTask(f.run.taskId, f.project.id).finally(() => { settled = true; });
    await tick();
    assert.deepEqual(new Set(seen), new Set([f.run.id, child.id]));
    assert.equal(settled, false);
    pending.resolve();
    await assert.rejects(result, error => error.message === 'research_task_stage_cleanup_failed' &&
      error.errors[0].message === 'sync_effect_failure');
  } finally { pending.resolve(); f.close(); }
});

test('corrupt execution identity does not skip stage cleanup and leaves the task fenced', async () => {
  const f = createResearchFixture(api, 'discovery');
  let stages = 0;
  try {
    f.agentDb.prepare("UPDATE research_task_executions SET snapshot_json=json_set(snapshot_json,'$.executionId','forged') WHERE kind='stage' AND execution_id=?")
      .run(f.run.id);
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: { async cancelTask() { stages += 1; } }, cancelChat: async () => {}, cancelJob: async () => {}
    });
    await assert.rejects(controller.cancel({ taskId: f.run.taskId, projectId: f.project.id }), /research_task_cleanup_failed/);
    assert.equal(stages, 1);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).statusReason, 'research_task_cleanup_failed');
    assert.throws(() => f.tasks.continueWith(f.run.taskId, f.project.id, () => {}), /research_task_cleanup_unconfirmed/);
  } finally { f.close(); }
});

test('stage cleanup still awaits effects when terminating a run throws', async () => {
  const f = createResearchFixture(api, 'discovery');
  const cleanup = deferred();
  const original = f.repository.runs.terminate;
  let called = false;
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {}, { complete: async () => {} }, {
    async cancelOwned() { called = true; await cleanup.promise; }
  });
  try {
    f.repository.runs.terminate = () => { throw new Error('terminate_failed'); };
    let finished = false;
    const stopping = runtime.stopTask(f.run.taskId, f.project.id, 'cancelled', 'test').finally(() => { finished = true; });
    await tick();
    assert.equal(called, true);
    assert.equal(finished, false);
    cleanup.resolve();
    await assert.rejects(stopping, /research_task_stage_cleanup_failed/);
  } finally { f.repository.runs.terminate = original; cleanup.resolve(); f.close(); }
});

test('stage cleanup continues for all executions when one stage snapshot is corrupt', async () => {
  const f = createResearchFixture(api, 'discovery');
  const calls = [];
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {}, { complete: async () => {} }, {
    async cancelOwned(_projectId, runId) { calls.push(runId); }
  });
  try {
    const child = { ...f.run, id: 'corrupt-cleanup-child', requestId: 'corrupt-cleanup-child', parentRunId: f.run.id };
    f.db.prepare(`INSERT INTO research_stage_runs
      (id,project_id,stage,request_id,parent_run_id,task_id,status,snapshot_json,context_json)
      SELECT ?,project_id,stage,?,?,task_id,status,?,context_json FROM research_stage_runs WHERE id = ?`)
      .run(child.id, child.requestId, f.run.id, JSON.stringify(child), f.run.id);
    f.tasks.linkStage({...child, executionSnapshot: {...child.executionSnapshot, nodeBinding: {kind: 'none'}}}, null);
    f.db.prepare("UPDATE research_stage_runs SET snapshot_json = json_set(snapshot_json, '$.id', 'wrong-id') WHERE id = ?")
      .run(f.run.id);
    await assert.rejects(runtime.stopTask(f.run.taskId, f.project.id, 'cancelled', 'test'), /research_task_stage_cleanup_failed/);
    assert.deepEqual(new Set(calls), new Set([f.run.id, child.id]));
    assert.equal(f.repository.runs.get(child.id, f.project.id).status, 'cancelled');
  } finally { f.close(); }
});

test('shutdown waits for effect cleanup and reports a cleanup failure', async () => {
  const f = createResearchFixture(api, 'discovery');
  const cleanup = deferred();
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    async prepare() { return { providerId: 'fixture', modelId: 'fixture', async execute({ signal }) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted');
    } }; }
  }, { complete: async () => {} }, {
    async cancelOwned() { await cleanup.promise; throw new Error('shutdown_effect_failed'); }
  });
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const running = runtime.retry({ projectId: f.project.id, runId: f.run.id, requestId: 'shutdown-cleanup' });
    await tick();
    let finished = false;
    const shutdown = runtime.shutdown().finally(() => { finished = true; });
    await tick();
    assert.equal(finished, false);
    assert.equal(f.tasks.get(running.taskId, f.project.id).statusReason, 'research_task_cleanup_pending');
    assert.throws(() => f.tasks.continueWith(running.taskId, f.project.id, () => {}), /research_task_cleanup_unconfirmed/);
    cleanup.resolve();
    await assert.rejects(shutdown, /research_shutdown_cleanup_failed/);
    assert.equal(f.tasks.get(running.taskId, f.project.id).statusReason, 'research_task_cleanup_failed');
  } finally { cleanup.resolve(); f.close(); }
});

test('cleanup pending remains fenced when a durable database is reopened', async () => {
  const f = createResearchFixture(api, 'discovery');
  const pending = deferred();
  const dir = mkdtempSync(join(tmpdir(), 'roc-task-cleanup-'));
  try {
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: { cancelTask: () => pending.promise }, cancelChat: async () => {}, cancelJob: async () => {}
    });
    const request = { taskId: f.run.taskId, projectId: f.project.id };
    const cancellation = controller.cancel(request);
    assert.equal(f.tasks.get(request.taskId, request.projectId).statusReason, 'research_task_cleanup_pending');
    const path = join(dir, 'agent.db');
    await f.agentDb.backup(path);
    const restoredDb = new Database(path);
    try {
      const restored = new api.ResearchTaskRepository(restoredDb);
      assert.throws(() => restored.continueWith(request.taskId, request.projectId, () => {}), /research_task_cleanup_unconfirmed/);
      const restoredController = new api.ResearchTaskController(restored, {
        stages: { cancelTask: async () => {} }, cancelChat: async () => {}, cancelJob: async () => {}
      });
      assert.equal((await restoredController.cancel(request)).statusReason, 'research_task_cleanup_failed');
      assert.throws(() => restored.continueWith(request.taskId, request.projectId, () => {}), /research_task_cleanup_unconfirmed/);
    } finally { restoredDb.close(); }
    pending.resolve();
    assert.equal((await cancellation).statusReason, 'research_task_cancelled');
  } finally { pending.resolve(); f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('synchronous cleanup errors still await other cleanup and persist the failure', async () => {
  const f = createResearchFixture(api, 'discovery');
  const pending = deferred();
  try {
    const execution = f.tasks.linkOwned({ kind: 'figure', executionId: 'sync-fault-figure', projectId: f.project.id,
      ownerRunId: null, goal: 'Owned work', snapshot: {} });
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: { cancelTask() { throw new Error('synchronous_cleanup_failure'); } },
      cancelChat: async () => {}, cancelJob: () => pending.promise
    });
    const request = { taskId: execution.taskId, projectId: f.project.id };
    const result = controller.cancel(request);
    assert.equal(controller.cancel(request), result);
    pending.resolve();
    await assert.rejects(result, error => error.message === 'research_task_cleanup_failed' &&
      error.errors[0].message === 'synchronous_cleanup_failure');
    const reopened = new api.ResearchTaskRepository(f.agentDb);
    assert.equal(reopened.get(request.taskId, request.projectId).statusReason, 'research_task_cleanup_failed');
    assert.throws(() => reopened.continueWith(request.taskId, request.projectId, () => {}), /research_task_cleanup_unconfirmed/);
  } finally { pending.resolve(); f.close(); }
});

test('standalone experiment, figure and export tasks call their own cancellation services', async () => {
  const f = createResearchFixture(api, 'discovery');
  const jobs = [];
  try {
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: { cancelTask: async () => {} },
      cancelChat: async () => { throw new Error('no_chat_expected'); },
      cancelJob: async (kind, projectId, id) => { assert.equal(projectId, f.project.id); jobs.push([kind, id]); }
    });
    for (const kind of ['experiment', 'figure', 'export']) {
      const execution = f.tasks.linkOwned({ kind, executionId: `${kind}-root`, projectId: f.project.id,
        ownerRunId: null, goal: 'Direct work', snapshot: {} });
      await controller.cancel({ taskId: execution.taskId, projectId: f.project.id });
    }
    assert.deepEqual(jobs, [['experiment', 'experiment-root'], ['figure', 'figure-root'], ['export', 'export-root']]);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, 'active');
  } finally { f.close(); }
});

test('actual agent cancellation capability propagates through a trusted chat association without recursion', async () => {
  const f = createResearchFixture(api, 'discovery');
  const handlers = new Map();
  const descriptors = [];
  let chatInvocations = 0;
  const capabilities = {
    register(_plugin, descriptor, handler) { descriptors.push(descriptor); handlers.set(descriptor.name, handler); },
    list: () => descriptors,
    async invoke(name, input) {
      if (name === 'agent.run.cancel') chatInvocations += 1;
      assert.ok(chatInvocations <= 2, 'task cancellation recursed');
      return await handlers.get(name)(input);
    }
  };
  const plugin = api.createAgentPlugin({ researchTasks: f.tasks, executionGrantBroker: api.openExecutionGrantBroker(f.agentDb) });
  try {
    const timestamp = '2026-11-03T00:00:00.000Z';
    f.agentDb.prepare(`INSERT INTO agent_threads
      (id,kind,title,goal,status,research_project_id,created_at,updated_at)
      VALUES ('parent-thread','chat','Parent','Research','active',?,?,?)`).run(f.project.id, timestamp, timestamp);
    f.agentDb.prepare(`INSERT INTO agent_runs
      (id,thread_id,run_number,user_input,status,started_at,ended_at,enabled_capabilities_json,run_origin)
      VALUES ('parent-chat','parent-thread',1,'Research','completed',?,?,'{}','chat')`).run(timestamp, timestamp);
    const execution = { ...f.tasks.requireExecution('stage',f.run.id,f.project.id), schemaVersion: 3, nodeBinding: {kind: 'none'}, taskId: f.run.taskId, projectId: f.project.id,
      kind: 'chat', executionId: 'parent-chat', parentKind: null, parentExecutionId: null,
      associationSource: 'direct', manifestHash: 'a'.repeat(64), createdAt: timestamp };
    f.agentDb.prepare(`INSERT INTO research_task_executions
      (kind,execution_id,task_id,project_id,snapshot_json,created_at) VALUES ('chat','parent-chat',?,?,?,?)`)
      .run(f.run.taskId, f.project.id, JSON.stringify(execution), timestamp);
    await plugin.initialize({
      pluginId: '@roc/plugin-agent', database: { getConnection: () => f.agentDb }, capabilities,
      eventBus: { publish: async () => {} }, logger: { warn: () => {}, error: () => {} }
    });
    const stages = new api.ResearchStageRuntime(f.repository, capabilities, {prepare: async () => {throw new Error('unexpected_prepare');}}, { complete: async () => {} }, {cancelOwned: async () => {}});
    api.registerResearchTaskCapabilities({ pluginId: '@roc/plugin-research', capabilities,
      eventBus: { publish: async () => {} }, logger: { warn: () => {} } }, f.tasks,
      new api.ResearchTaskController(f.tasks, {
        stages, cancelChat: async runId => await capabilities.invoke('agent.run.cancel', { runId }),
        cancelJob: async () => { throw new Error('no_job_expected'); }
      }), new api.ResearchTaskDiagnosticsService(f.repository, new api.RunUsageLedger(f.agentDb), null, {source: async () => {throw new Error('fixture_resource_source_unused');}}),
      {export: async () => {throw new Error('fixture_export_unused');}});
    const result = await capabilities.invoke('agent.run.cancel', { runId: 'parent-chat' });
    assert.equal(result.cancelled, false);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, 'cancelled');
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).status, 'cancelled');
    assert.equal(chatInvocations, 2);
  } finally { await plugin.shutdown(); f.close(); }
});

test('task IPC and capability requests reject trusted parent fields and cross-project cancellation', async () => {
  const f = createResearchFixture(api, 'discovery');
  const handlers = new Map();
  try {
    api.registerResearchTaskCapabilities({ pluginId: 'fixture',
      eventBus: { publish: async () => {} }, logger: { warn: () => {} }, capabilities: {
      register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); }
    } }, f.tasks, new api.ResearchTaskController(f.tasks, {
      stages: { cancelTask: async () => {} }, cancelChat: async () => {}, cancelJob: async () => {}
    }), new api.ResearchTaskDiagnosticsService(f.repository, new api.RunUsageLedger(f.agentDb), null, {source: async () => {throw new Error('fixture_resource_source_unused');}}),
    {export: async () => {throw new Error('fixture_export_unused');}});
    const request = { taskId: f.run.taskId, projectId: f.project.id };
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:task-cancel', [request]), [request]);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:task-cancel', [{ ...request, parentRunId: 'forged' }]));
    await assert.rejects(handlers.get('research.task.cancel')({ ...request, projectId: 'foreign' }), /research_task_project_mismatch/);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).status, 'active');
    const tree = await handlers.get('research.task.executions')(request);
    assert.equal(tree[0].executionId, f.run.id);
    assert.equal((await handlers.get('research.task.cancel')(request)).status, 'cancelled');
  } finally { f.close(); }
});
