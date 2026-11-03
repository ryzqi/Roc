import assert from 'node:assert/strict';
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
  const budget = { ...f.tasks.budgetForExecution('stage', f.run.id, f.project.id),
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
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
  });
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const current = runtime.retry({ projectId: f.project.id, runId: f.run.id, requestId: 'current' });
    const otherProject = f.repository.createProject({ title: 'Unrelated', description: '', workspacePath: '/tmp/other-task' });
    const other = runtime.start({
      projectId: otherProject.id, expectedStage: 'discovery', instruction: 'Independent stage', requestId: 'other'
    });
    await tick();
    assert.equal(calls.size, 2);
    const child = { ...f.repository.runs.get(current.id, f.project.id), id: 'review-child',
      parentRunId: current.id, retryOfRunId: null, requestId: 'review-child', role: 'reviewer' };
    f.db.prepare(`INSERT INTO research_stage_runs
      (id,project_id,stage,request_id,parent_run_id,task_id,status,snapshot_json,context_json)
      SELECT ?,project_id,stage,?,?,task_id,status,?,context_json FROM research_stage_runs WHERE id = ?`)
      .run(child.id, child.requestId, current.id, JSON.stringify(child), current.id);
    f.tasks.linkStage(child, null);
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: runtime, cancelChat: async () => { throw new Error('no_chat_expected'); },
      cancelJob: async () => { throw new Error('no_job_expected'); }
    });
    const request = { taskId: current.taskId, projectId: f.project.id };
    let finished = false;
    const cancelled = controller.cancel(request).then(task => { finished = true; return task; });
    assert.equal(f.tasks.get(current.taskId, f.project.id).status, 'cancelled');
    assert.throws(() => f.tasks.budgetForExecution('stage', current.id, f.project.id), /research_task_not_active/);
    assert.throws(() => new api.RunBudgetLedger(f.agentDb).reserve(current.id, budget, {
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
    runtime.cancel({ projectId: otherProject.id, runId: other.id });
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
  const budget = { ...f.tasks.budgetForExecution('stage', f.run.id, f.project.id),
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
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
    f.tasks.cancel(f.run.taskId, f.project.id);
    const ledger = new api.RunBudgetLedger(f.agentDb);
    assert.throws(() => ledger.reserve(f.run.id, budget, {
      id: 'late', kind: 'model', tokens: 1, inputHash: 'late', envelope: {}
    }), /research_task_not_active/);
  } finally { f.close(); }
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
  const plugin = api.createAgentPlugin({ researchTasks: f.tasks });
  try {
    const timestamp = '2026-11-03T00:00:00.000Z';
    f.agentDb.prepare(`INSERT INTO agent_threads
      (id,kind,title,goal,status,research_project_id,created_at,updated_at)
      VALUES ('parent-thread','chat','Parent','Research','active',?,?,?)`).run(f.project.id, timestamp, timestamp);
    f.agentDb.prepare(`INSERT INTO agent_runs
      (id,thread_id,run_number,user_input,status,started_at,ended_at,enabled_capabilities_json,run_origin)
      VALUES ('parent-chat','parent-thread',1,'Research','completed',?,?,'{}','chat')`).run(timestamp, timestamp);
    const execution = { schemaVersion: 1, taskId: f.run.taskId, projectId: f.project.id,
      kind: 'chat', executionId: 'parent-chat', parentKind: null, parentExecutionId: null,
      associationSource: 'direct', manifestHash: 'a'.repeat(64), createdAt: timestamp };
    f.agentDb.prepare(`INSERT INTO research_task_executions
      (kind,execution_id,task_id,project_id,snapshot_json,created_at) VALUES ('chat','parent-chat',?,?,?,?)`)
      .run(f.run.taskId, f.project.id, JSON.stringify(execution), timestamp);
    await plugin.initialize({
      pluginId: '@roc/plugin-agent', database: { getConnection: () => f.agentDb }, capabilities,
      eventBus: { publish: async () => {} }, logger: { warn: () => {}, error: () => {} }
    });
    const stages = new api.ResearchStageRuntime(f.repository, capabilities, undefined, { complete: async () => {} });
    api.registerResearchTaskCapabilities({ pluginId: '@roc/plugin-research', capabilities }, f.tasks,
      new api.ResearchTaskController(f.tasks, {
        stages, cancelChat: async runId => await capabilities.invoke('agent.run.cancel', { runId }),
        cancelJob: async () => { throw new Error('no_job_expected'); }
      }), new api.ResearchTaskDiagnosticsService(f.repository, new api.RunBudgetLedger(f.agentDb)));
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
    api.registerResearchTaskCapabilities({ pluginId: 'fixture', capabilities: {
      register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); }
    } }, f.tasks, new api.ResearchTaskController(f.tasks, {
      stages: { cancelTask: async () => {} }, cancelChat: async () => {}, cancelJob: async () => {}
    }), new api.ResearchTaskDiagnosticsService(f.repository, new api.RunBudgetLedger(f.agentDb)));
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
