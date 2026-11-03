import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

test('project task listing uses stable creation cursors despite identical timestamps and status updates', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const second = f.tasks.linkStage({ ...f.run, id: 'second-stage', taskId: null, requestId: 'second-stage' }, null);
    const third = f.tasks.linkStage({ ...f.run, id: 'third-stage', taskId: null, requestId: 'third-stage' }, null);
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
