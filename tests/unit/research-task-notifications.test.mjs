import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());
const tick = () => new Promise(resolve => setImmediate(resolve));

test('stage invalidation follows trusted linkage and the final persisted task state', async () => {
  const f = createResearchFixture(api, 'discovery');
  const updates = [];
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    async prepare() { throw new Error('research_fixture_model_failure'); }
  }, { complete: async () => {} }, undefined, (taskId, projectId) => {
    updates.push({ taskId, projectId, status: f.tasks.get(taskId, projectId).status });
  });
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const run = runtime.retry({ projectId: f.project.id, runId: f.run.id, requestId: 'new-stage' });
    await runtime.waitForIdle();
    assert.deepEqual(updates, [
      { taskId: run.taskId, projectId: f.project.id, status: 'active' },
      { taskId: run.taskId, projectId: f.project.id, status: 'failed' }
    ]);
    const events = f.tasks.events({ taskId: run.taskId, projectId: f.project.id, afterSequence: 0, limit: 200 }).events;
    assert.ok(events.some(event => event.eventType === 'execution_linked' && event.executionId === run.id));
    assert.equal(events.at(-1).state, 'failed');
  } finally { await runtime.shutdown(); f.close(); }
});

test('failed task cleanup invalidates its persisted failure and foreign requests emit nothing', async () => {
  const f = createResearchFixture(api, 'discovery');
  const handlers = new Map();
  const updates = [];
  try {
    const context = {
      pluginId: 'fixture', logger: { warn: () => {} },
      eventBus: { publish: async event => { updates.push(event); } },
      capabilities: { register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); } }
    };
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: { async cancelTask() { throw new Error('fixture_cleanup_failure'); } },
      cancelChat: async () => {}, cancelJob: async () => {}
    });
    api.registerResearchTaskCapabilities(context, f.tasks, controller,
      new api.ResearchTaskDiagnosticsService(f.repository, new api.RunBudgetLedger(f.agentDb), null, {source: async () => {throw new Error('fixture_resource_source_unused');}}),
      {export: async () => {throw new Error('fixture_export_unused');}});
    const request = { taskId: f.run.taskId, projectId: f.project.id };
    await assert.rejects(handlers.get('research.task.cancel')({ ...request, projectId: 'foreign' }), /research_task_project_mismatch/);
    assert.deepEqual(updates, []);
    await assert.rejects(handlers.get('research.task.cancel')(request), /research_task_cleanup_failed/);
    assert.equal(f.tasks.get(f.run.taskId, f.project.id).statusReason, 'research_task_cleanup_failed');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].type, 'research.task.updated');
    assert.deepEqual(updates[0].payload, request);
    assert.throws(() => f.tasks.continueWith(f.run.taskId, f.project.id, () => {}), /research_task_cleanup_unconfirmed/);
  } finally { f.close(); }
});

test('notification delivery errors do not change execution records or authoritative budget state', async () => {
  const f = createResearchFixture(api, 'discovery');
  const warnings = [];
  try {
    const previous = f.tasks.get(f.run.taskId, f.project.id);
    const ledger = new api.RunBudgetLedger(f.agentDb);
    const budget = ledger.readTaskBudgetStatus(f.run.taskId, f.project.id);
    api.notifyResearchTaskChanged({
      pluginId: 'fixture', eventBus: { publish: async () => { throw new Error('fixture_notification_failure'); } },
      logger: { warn: (...args) => warnings.push(args) }
    }, f.run.taskId, f.project.id);
    await tick();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'research_task_notification_failed');
    assert.deepEqual(f.tasks.get(f.run.taskId, f.project.id), previous);
    assert.deepEqual(ledger.readTaskBudgetStatus(f.run.taskId, f.project.id), budget);
  } finally { f.close(); }
});
