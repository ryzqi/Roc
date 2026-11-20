import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const plain = {title: 'Review', markdown: 'Controlled engineering fixture.', claims: [], sections: [], verdict: 'uncertain'};
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const [label, failure, reason] of [
  ['provider reply loop', new Error('magpie ended this reply: the model\'s text was stuck in a loop, its last 256 lines repeated. (502: you can retry your request)'), 'research_provider_reply_loop'],
  ['wrapped provider reply loop', new Error('Model middleware failed', {cause: new Error('Stream failed', {
    cause: new Error('magpie ended this reply: the model\'s text was stuck in a loop, its last 256 lines repeated.')
  })}), 'research_provider_reply_loop'],
  ['unrelated loop wording', new Error('Tool loop failed with private request details'), 'research_role_execution_failed'],
  ['existing research code', new Error('research_stage_inputs_stale'), 'research_stage_inputs_stale'],
  ['cyclic error cause', (() => {const error = new Error('Unknown failure'); error.cause = error; return error;})(), 'research_role_execution_failed']
]) {
  test(`review failure preserves a safe reason for ${label} without approving output`, async () => {
    const f = createScientificReviewFixture(api);
    let calls = 0;
    const runtime = new api.ResearchStageRuntime(f.repository, {}, {async prepare() {
      return {providerId: 'fixture', modelId: 'fixture', async execute() {calls += 1; throw failure;}};
    }}, api.createResearchHumanGate({repository: f.repository}), {cancelOwned: async () => {}}, undefined, 1);
    try {
      await runtime.stopTask(f.parent.taskId, f.project.id, 'interrupted', 'fixture_restart');
      const run = runtime.retry({projectId: f.project.id, runId: f.parent.id, requestId: label});
      await runtime.waitForIdle();
      const task = f.tasks.get(run.taskId, f.project.id);
      assert.equal(task.status, 'failed');
      assert.equal(task.statusReason, reason);
      assert.equal(calls, 1, 'a provider failure must not automatically retry');
      const child = f.repository.runs.list({projectId: f.project.id, limit: 100})
        .find(item => item.parentRunId === run.id && item.status === 'failed');
      assert.ok(child);
      assert.equal(child.error, reason);
      assert.deepEqual(child.outputArtifactIds, []);
      const review = f.repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'review');
      assert.equal(review.status, 'paused');
      assert.equal(f.repository.listArtifacts(f.project.id).filter(artifact => artifact.status === 'draft').length, 0);
    } finally {await runtime.shutdown(); f.close();}
  });
}

test('dispatch-validation cleanup wakes the next same-project root', async () => {
  const f = createResearchFixture(api, 'planning');
  let release, invalid;
  const cleanup = new Promise(resolve => {release = resolve;});
  let calls = 0;
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {async prepare() {
    return {providerId: 'fixture', modelId: 'fixture', async execute() {
      calls += 1;
      return {modelVersion: null, output: plain};
    }};
  }}, api.createResearchHumanGate({repository: f.repository}), {
    cancelOwned: async (_projectId, runId) => {if (runId === invalid?.id) await cleanup;}
  });
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    invalid = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'planning',
      instruction: 'Invalid queued root', requestId: 'bad'});
    f.db.prepare("UPDATE research_stage_runs SET context_json='{}' WHERE id=?").run(invalid.id);
    runtime.resumeScheduler();
    assert.equal(f.tasks.get(invalid.taskId, f.project.id).statusReason, 'research_task_cleanup_pending');
    const queued = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'planning',
      instruction: 'Next root', requestId: 'next'});
    runtime.resumeScheduler();
    assert.equal(calls, 0);
    assert.equal(f.tasks.graph.read(queued.taskId, f.project.id).nodes[0].reason, 'research_task_cleanup_pending');
    release();
    await runtime.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(f.repository.runs.get(queued.id, f.project.id).status, 'completed');
  } finally {release(); await runtime.shutdown(); f.close();}
});

test('confirmed cleanup wakes a queued root in the same project without another user dispatch', async () => {
  const f = createResearchFixture(api, 'planning');
  let release;
  const cleanup = new Promise(resolve => {release = resolve;});
  let calls = 0;
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {async prepare() {
    return {providerId: 'fixture', modelId: 'fixture', async execute() {
      calls += 1;
      return {modelVersion: null, output: plain};
    }};
  }}, api.createResearchHumanGate({repository: f.repository}), {
    cancelOwned: async (_projectId, runId) => {if (runId === f.run.id) await cleanup;}
  });
  const controller = new api.ResearchTaskController(f.tasks, {
    stages: runtime, cancelChat: async () => assert.fail('unexpected chat'), cancelJob: async () => assert.fail('unexpected job')
  }, () => runtime.resumeScheduler());
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const pausing = controller.pause({taskId: f.run.taskId, projectId: f.project.id});
    const queued = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'planning',
      instruction: 'Next independent root', requestId: 'after-cleanup'});
    assert.notEqual(queued.taskId, f.run.taskId);
    runtime.resumeScheduler();
    await tick();
    assert.equal(calls, 0);
    assert.equal(f.tasks.graph.read(queued.taskId, f.project.id).nodes[0].reason, 'research_task_cleanup_pending');
    release();
    await pausing;
    await runtime.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(f.repository.runs.get(queued.id, f.project.id).status, 'completed');
    assert.equal(f.tasks.get(queued.taskId, f.project.id).status, 'waiting_approval');
  } finally {release(); await runtime.shutdown(); f.close();}
});

for (const concurrency of [1, 2]) {
  test(`one scheduler with ${concurrency} slots completes three independent reviewers before the reducer`, async () => {
    const f = createScientificReviewFixture(api);
    let running = 0, maximum = 0;
    const finished = [], starts = [];
    const runtime = new api.ResearchStageRuntime(f.repository, {}, {async prepare() {
      return {providerId: 'fixture', modelId: 'fixture', async execute({run, context}) {
        starts.push(run.role); running += 1; maximum = Math.max(maximum, running);
        try {
          if (run.parentRunId === null) {
            assert.equal(finished.length, 3);
            assert.equal(context.reviewReports.length, 3);
          } else assert.equal(context.reviewReports.length, 0);
          await delay(10);
          finished.push(run.role);
          return {modelVersion: null, output: run.parentRunId === null ? plain : {...plain, scientificReview: f.output(run)}};
        } finally {running -= 1;}
      }};
    }}, api.createResearchHumanGate({repository: f.repository}), {cancelOwned: async () => {}}, undefined, concurrency);
    try {
      await runtime.stopTask(f.parent.taskId, f.project.id, 'interrupted', 'fixture_restart');
      const run = runtime.retry({projectId: f.project.id, runId: f.parent.id, requestId: `slots-${concurrency}`});
      await runtime.waitForIdle();
      assert.equal(f.repository.runs.get(run.id, f.project.id).status, 'completed', JSON.stringify(f.repository.runs.list({projectId: f.project.id, limit: 100}).map(item => ({role: item.role, status: item.status, error: item.error}))));
      assert.equal(f.tasks.get(run.taskId, f.project.id).status, 'waiting_approval');
      assert.equal(maximum, concurrency); assert.equal(starts.length, 4);
      const graph = f.tasks.graph.read(run.taskId, f.project.id);
      const node = graph.nodes.find(node => node.executionId === run.id);
      assert.equal(node.status, 'pending_review'); assert.equal(node.lease, null);
      const dependencies = graph.edges.filter(edge => edge.dependent === node.id);
      assert.equal(dependencies.length, 3);
      for (const edge of dependencies) assert.equal(graph.nodes.find(node => node.id === edge.prerequisite).status, 'done');
      assert.equal(f.repository.listArtifacts(f.project.id).filter(artifact => artifact.status === 'draft').length, 4);
    } finally {await runtime.shutdown(); f.close();}
  });

  test(`shutdown fences active reviewers, queued children and the reducer with ${concurrency} slots`, async () => {
    const f = createScientificReviewFixture(api);
    const started = [];
    const runtime = new api.ResearchStageRuntime(f.repository, {}, {async prepare() {
      return {providerId: 'fixture', modelId: 'fixture', async execute({run, signal}) {
        started.push(run.id);
        await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
        throw signal.reason;
      }};
    }}, {complete: async () => assert.fail('shutdown must not complete output')}, {cancelOwned: async () => {}}, undefined, concurrency);
    try {
      await runtime.stopTask(f.parent.taskId, f.project.id, 'interrupted', 'fixture_restart');
      const run = runtime.retry({projectId: f.project.id, runId: f.parent.id, requestId: 'shutdown'});
      await tick(); assert.equal(started.length, concurrency, f.tasks.get(run.taskId, f.project.id).statusReason);
      await runtime.shutdown();
      const graph = f.tasks.graph.read(run.taskId, f.project.id);
      assert.equal(graph.nodes.some(node => ['pending', 'ready', 'running'].includes(node.status)), false);
      assert.equal(graph.nodes.some(node => node.lease !== null), false);
      assert.equal(f.tasks.get(run.taskId, f.project.id).status, 'interrupted');
      assert.equal(f.tasks.get(run.taskId, f.project.id).statusReason, 'research_run_interrupted_by_shutdown');
      assert.throws(() => runtime.retry({projectId: f.project.id, runId: run.id, requestId: 'late'}), /research_scheduler_closed/);
    } finally {await runtime.shutdown(); f.close();}
  });
}
