import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import Database from 'better-sqlite3';
import {withResearchTestWorker, createResearchFixture, loadResearchTestApi, unknownExperiment} from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

test('the frozen stage material includes canonical manuscript section names and paragraph order with the same timestamp', async () => {
  const f = createResearchFixture(api, 'writing');
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    f.repository.knowledge.upsertFromSource({id: 'frozen-sections', projectId: f.project.id, sourceType: 'file', sourceId: 'notes.txt',
      title: 'Observed results', content: 'Observed results', chunks: [{content: 'Observed results', locator: 'block:0'}], embeddingPolicy: 'none'});
    const source = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'frozen-sections:chunk:0'});
    const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'writing', kind: 'manuscript', title: 'Frozen manuscript', path: null});
    const claims = ['First result', 'Second result'].map(content => f.repository.evidence.createClaim({projectId: f.project.id,
      artifactId: artifact.id, subjectType: 'paragraph', content, status: 'supported', experiment: {...unknownExperiment}, evidenceIds: [source.id]}));
    const original = [{title: 'Results', claimIds: claims.map(claim => claim.id)}];
    f.repository.manuscripts.saveManuscript({artifactId: artifact.id, sections: original});
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(artifact.id);
    f.db.prepare("UPDATE research_projects SET current_stage='planning' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='planning'").run(f.project.id);
    const queued = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'planning', instruction: 'Use the same canonical text', requestId: 'sections'});
    f.repository.runs.assertInputsCurrent(queued);
    for (const changed of [
      [{title: 'Revised Results', claimIds: claims.map(claim => claim.id)}],
      [{title: 'Results', claimIds: claims.map(claim => claim.id).reverse()}]
    ]) {
      f.db.prepare('UPDATE research_manuscripts SET sections_json=? WHERE artifact_id=?').run(JSON.stringify(changed), artifact.id);
      assert.throws(() => f.repository.runs.assertInputsCurrent(queued), /research_stage_inputs_stale/u);
      f.db.prepare('UPDATE research_manuscripts SET sections_json=? WHERE artifact_id=?').run(JSON.stringify(original), artifact.id);
      f.repository.runs.assertInputsCurrent(queued);
    }
  } finally {await f.close();}
});

for (const change of ['approval', 'content']) {
  test(`stage rejects changed ${change} before dispatch, completion and retry after reopening`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roc-stage-inputs-'));
    const f = createResearchFixture(api, 'planning');
    let db, agentDb;
    try {
      f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
      const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'planning',
        kind: 'research_plan', title: 'Approved input', path: null});
      f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(artifact.id);
      const queued = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'planning',
        instruction: 'Use the approved input', requestId: 'frozen'});
      await f.db.backup(join(directory, 'research.db'));
      await f.agentDb.backup(join(directory, 'agent.db'));
      f.close();
      db = new Database(join(directory, 'research.db'));
      agentDb = new Database(join(directory, 'agent.db'));
      api.applyResearchDatabaseSchema(db, () => '2026-11-03T00:00:00.000Z');
      api.applyAgentDatabaseSchema(agentDb);
      const tasks = new api.ResearchTaskRepository(agentDb, () => '2026-11-03T00:00:00.000Z');
      const repository = new api.ResearchRepository(db, tasks, () => '2026-11-03T00:00:00.000Z');
      assert.equal(withResearchTestWorker(api, repository, queued.id, f.project.id, () => repository.runs.requireActive(queued.id, f.project.id)).id, queued.id);
      const mutate = () => db.prepare(change === 'approval'
        ? "UPDATE research_artifacts SET status='draft' WHERE id=?"
        : "UPDATE research_artifacts SET title='Changed without a new timestamp' WHERE id=?").run(artifact.id);
      mutate();
      assert.throws(() => withResearchTestWorker(api, repository, queued.id, f.project.id, workerRunId => repository.runs.markRunning(workerRunId, f.project.id, {providerId: 'fixture', modelId: 'fixture'})), /research_stage_inputs_stale/);
      db.prepare("UPDATE research_artifacts SET status='approved',title='Approved input' WHERE id=?").run(artifact.id);
      withResearchTestWorker(api, repository, queued.id, f.project.id, workerRunId => repository.runs.markRunning(workerRunId, f.project.id, {providerId: 'fixture', modelId: 'fixture'}));
      mutate();
      assert.throws(() => withResearchTestWorker(api, repository, queued.id, f.project.id, workerRunId => repository.runs.complete(workerRunId, f.project.id, {title: 'Plan', markdown: 'Stale result', claims: [], sections: [], verdict: 'ready'})), /research_stage_inputs_stale/);
      assert.deepEqual(repository.runs.get(queued.id, f.project.id).outputArtifactIds, []);
      repository.runs.terminate(queued.id, f.project.id, 'interrupted', 'fixture_restart');
      tasks.setStatus(queued.taskId, f.project.id, 'interrupted', 'fixture_restart', ['active']);
      const diagnostics = new api.ResearchTaskDiagnosticsService(repository, new api.RunUsageLedger(agentDb), null,
        {source: async () => {throw new Error('unexpected_resource_read');}});
      const summary = diagnostics.get({projectId: f.project.id, taskId: queued.taskId});
      assert.deepEqual(summary.recoveryIssues, ['research_stage_inputs_stale']);
      assert.equal(summary.continuationRunId, null);
      assert.throws(() => repository.runs.retry({projectId: f.project.id, runId: queued.id, requestId: 'retry'}), /research_stage_inputs_stale/);
      assert.equal(repository.runs.list({projectId: f.project.id, limit: 20}).length, 2);
    } finally {
      if (f.db.open) f.close();
      db?.close(); agentDb?.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });
}

test('approval restoration refuses inputs changed after the completed stage was paused', async () => {
  const f = createResearchFixture(api, 'planning');
  const gate = api.createResearchHumanGate({repository: f.repository});
  const runtime = new api.ResearchStageRuntime(f.repository, {},
    {prepare: async () => {throw new Error('unexpected_prepare');}}, gate, {cancelOwned: async () => {}});
  const controller = new api.ResearchTaskController(f.tasks, {stages: runtime, cancelChat: async () => {}, cancelJob: async () => {}});
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    f.db.prepare("UPDATE research_projects SET current_stage='discovery' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='discovery'").run(f.project.id);
    const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'discovery',
      kind: 'search_strategy', title: 'Approved input', path: null});
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(artifact.id);
    f.db.prepare("UPDATE research_projects SET current_stage='planning' WHERE id=?").run(f.project.id);
    const run = f.repository.runs.begin({projectId: f.project.id, expectedStage: 'planning',
      instruction: 'Use the approved input', requestId: 'approval-input'});
    withResearchTestWorker(api, f.repository, run.id, f.project.id, workerRunId => f.repository.runs.markRunning(workerRunId, f.project.id, {providerId: 'fixture', modelId: 'fixture'}));
    withResearchTestWorker(api, f.repository, run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {title: 'Plan', markdown: 'Plan', claims: [], sections: [], verdict: 'ready'}));
    await gate.complete({projectId: f.project.id, expectedStage: 'planning', action: 'complete'});
    runtime.synchronizeTaskState(run.taskId, f.project.id);
    const request = {projectId: f.project.id, taskId: run.taskId};
    await controller.pause(request);
    f.db.prepare("UPDATE research_artifacts SET status='draft' WHERE id=?").run(artifact.id);
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunUsageLedger(f.agentDb), null,
      {source: async () => {throw new Error('unexpected_resource_read');}});
    const summary = diagnostics.get(request);
    assert.equal(summary.canRestoreApproval, false);
    assert.deepEqual(summary.recoveryIssues, ['research_stage_inputs_stale']);
    assert.throws(() => controller.restoreApproval(request), /research_stage_inputs_stale/);
    assert.equal(f.tasks.get(run.taskId, f.project.id).status, 'paused');
  } finally {await runtime.shutdown(); f.close();}
});
