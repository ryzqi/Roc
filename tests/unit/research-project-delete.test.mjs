import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {
  createResearchFixture,
  loadResearchTestApi,
  withResearchTestWorker
} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

function completeAndReview(f, project = f.project, run = f.run) {
  const completed = withResearchTestWorker(api, f.repository, run.id, project.id, () =>
    f.repository.runs.complete(run.id, project.id, {
      title: 'Plan', markdown: 'Saved output', claims: [], sections: [], verdict: 'ready'
    }));
  f.repository.transitionWorkflow({projectId: project.id, expectedStage: 'planning', action: 'complete'});
  const expectedArtifactVersions = completed.outputArtifactIds.map(artifactId => ({
    artifactId,
    version: f.repository.inspectArtifact({
      projectId: project.id, artifactId, expectedVersion: null
    }).snapshot.version
  }));
  f.repository.transitionWorkflow({
    projectId: project.id, expectedStage: 'planning', action: 'reject', expectedArtifactVersions
  });
}

function secondReviewedProject(f) {
  const project = f.repository.createProject({
    title: 'Keep this project', description: '', workspacePath: '/tmp/roc-delete-survivor'
  });
  f.db.prepare("UPDATE research_projects SET current_stage = 'planning' WHERE id = ?").run(project.id);
  f.db.prepare("UPDATE research_stage_states SET status = 'ready' WHERE project_id = ? AND stage = 'planning'")
    .run(project.id);
  const queued = f.repository.runs.begin({
    projectId: project.id, expectedStage: 'planning', instruction: 'Another plan', requestId: 'second-project'
  });
  f.tasks.linkStage(queued, null);
  f.repository.runs.bindTask(queued.id, project.id);
  const run = withResearchTestWorker(api, f.repository, queued.id, project.id, () =>
    f.repository.runs.markRunning(queued.id, project.id, {
      providerId: 'fixture-provider', modelId: 'fixture-model'
    }));
  completeAndReview(f, project, run);
  return project;
}

test('deleting a reviewed project removes its receipts and preserves another project and its receipts', () => {
  const f = createResearchFixture(api, 'planning');
  try {
    completeAndReview(f);
    const survivor = secondReviewedProject(f);
    const decisions = f.db.prepare('SELECT * FROM research_node_decision_receipts ORDER BY node_id').all();
    const outputs = f.db.prepare('SELECT * FROM research_node_output_receipts ORDER BY execution_id').all();
    assert.equal(decisions.length, 2);
    assert.equal(outputs.length, 2);
    assert.deepEqual(f.repository.deleteProject(f.project.id), {id: f.project.id, deleted: true});
    assert.throws(() => f.repository.getProject(f.project.id), /research_project_not_found/);
    assert.equal(f.repository.getProject(survivor.id).title, survivor.title);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM research_node_decision_receipts ORDER BY node_id').all(),
      decisions.filter(row => row.project_id === survivor.id)
    );
    assert.deepEqual(
      f.db.prepare('SELECT * FROM research_node_output_receipts ORDER BY execution_id').all(),
      outputs.filter(row => row.execution_id !== f.run.id)
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {f.close();}
});

test('a failed project delete rolls back both receipt cleanups', () => {
  const f = createResearchFixture(api, 'planning');
  try {
    completeAndReview(f);
    const decisions = f.db.prepare('SELECT * FROM research_node_decision_receipts').all();
    const outputs = f.db.prepare('SELECT * FROM research_node_output_receipts').all();
    f.db.exec(`CREATE TRIGGER reject_project_delete BEFORE DELETE ON research_projects
      BEGIN SELECT RAISE(ABORT, 'fixture_delete_rejected'); END;`);
    assert.throws(() => f.repository.deleteProject(f.project.id), /fixture_delete_rejected/);
    assert.equal(f.repository.getProject(f.project.id).id, f.project.id);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_node_decision_receipts').all(), decisions);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_node_output_receipts').all(), outputs);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {f.close();}
});

test('a project without receipts deletes and a missing project still reports its original error', () => {
  const f = createResearchFixture(api, 'planning');
  try {
    assert.deepEqual(f.repository.deleteProject(f.project.id), {id: f.project.id, deleted: true});
    assert.throws(() => f.repository.deleteProject(f.project.id), /research_project_not_found/);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {f.close();}
});
