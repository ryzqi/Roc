import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {captureResearchArtifactVersions, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

function appendOpenResponse(f) {
  const inspected = f.repository.responseMatrix.inspect({
    projectId: f.project.id, artifactId: f.artifactId, expectedHash: null
  });
  return api.withResearchHumanContext({
    capability: 'research.responseMatrix.save', projectId: f.project.id, windowId: 24
  }, () => f.repository.responseMatrix.save({
    projectId: f.project.id, artifactId: f.artifactId, requestId: 'open-response',
    expectedArtifactVersion: inspected.report.artifactVersion, parent: null,
    rationale: 'Keep the unresolved uncertainty finding available for revision.',
    rows: [{commentId: 'c1', reviewer: 'Human', comment: 'Retain uncertainty.', status: 'open',
      response: 'Revision is still required.', locations: [], evidenceIds: []}]
  }));
}

test('fresh human review can request revision after saved matrix invalidates startup task recovery', async () => {
  const f = createScientificReviewFixture(api);
  const gate = api.createResearchHumanGate({repository: f.repository});
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    prepare: async () => assert.fail('reviewing saved output must not dispatch a model')
  }, gate, {cancelOwned: async () => {}});
  try {
    f.complete();
    appendOpenResponse(f);
    await runtime.recoverPendingOutputs();
    const failed = f.tasks.get(f.parent.taskId, f.project.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.statusReason, 'research_stage_inputs_stale');
    assert.equal(f.repository.scientificReviews.reportsForManuscript(f.project.id, f.artifactId)
      .every(report => report.status === 'current'), true);
    const next = await gate.approve({
      projectId: f.project.id, expectedStage: 'review', action: 'approve', reviewDecision: 'revise',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)
    });
    assert.equal(next.currentStage, 'revision');
    assert.deepEqual(f.tasks.get(f.parent.taskId, f.project.id), failed,
      'a human decision must not reactivate the failed task');
    const binding = f.tasks.requireExecution('stage', f.parent.id, f.project.id).nodeBinding;
    assert.equal(f.tasks.graph.get(binding.nodeId, f.project.id).status, 'done');
    assert.equal(f.repository.responseMatrix.history({
      projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 10
    }).items.length, 1);
  } finally { await runtime.shutdown(); f.close(); }
});

for (const [status, reason] of [
  ['paused', 'research_task_paused'], ['cancelled', 'research_task_cancelled'],
  ['interrupted', 'research_task_interrupted_by_restart'], ['failed', 'research_task_effect_unresolved']
]) {
  test(`saved review cannot bypass ${status}/${reason}`, async () => {
    const f = createScientificReviewFixture(api);
    try {
      f.complete();
      f.tasks.setStatus(f.parent.taskId, f.project.id, status, reason, ['active']);
      const before = f.repository.getWorkflow(f.project.id);
      await assert.rejects(api.createResearchHumanGate({repository: f.repository}).approve({
        projectId: f.project.id, expectedStage: 'review', action: 'approve', reviewDecision: 'revise',
        expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)
      }), /research_task_not_active/);
      assert.deepEqual(f.repository.getWorkflow(f.project.id), before);
    } finally { f.close(); }
  });
}

test('stale reviewed versions cannot approve a task that failed input recovery', async () => {
  const f = createScientificReviewFixture(api);
  try {
    f.complete();
    const versions = captureResearchArtifactVersions(f.repository, f.project.id);
    // Alter a review artifact after capturing the human's versions.
    const artifactId = versions[0].artifactId;
    f.db.prepare('UPDATE research_artifacts SET title=? WHERE id=?').run('Changed after inspection', artifactId);
    f.tasks.setStatus(f.parent.taskId, f.project.id, 'failed', 'research_stage_inputs_stale', ['active']);
    const before = f.repository.getWorkflow(f.project.id);
    await assert.rejects(api.createResearchHumanGate({repository: f.repository}).approve({
      projectId: f.project.id, expectedStage: 'review', action: 'approve', reviewDecision: 'revise',
      expectedArtifactVersions: versions
    }), /research_artifact_review_changed/);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), before);
  } finally { f.close(); }
});

test('failed input recovery cannot approve saved output with unresolved tool effects', async () => {
  const f = createScientificReviewFixture(api);
  try {
    f.complete();
    const binding = f.tasks.requireExecution('stage', f.parent.id, f.project.id).nodeBinding;
    const store = new api.AgentToolEffectStore(f.agentDb);
    store.beginOperation({
      runId: binding.nodeId, threadId: 'recovery-effects', executionPath: 'main',
      checkpointId: 'checkpoint', toolCallId: 'write-call', toolName: 'write',
      canonicalToolIdentity: 'fixture.write', toolVersion: '1', args: {},
      effectClass: 'external_call', reconcileStrategy: 'manual_confirmation'
    });
    f.tasks.setStatus(f.parent.taskId, f.project.id, 'failed', 'research_stage_inputs_stale', ['active']);
    const before = f.repository.getWorkflow(f.project.id);
    await assert.rejects(api.createResearchHumanGate({repository: f.repository}).approve({
      projectId: f.project.id, expectedStage: 'review', action: 'approve', reviewDecision: 'revise',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)
    }), /research_task_effect_unresolved/);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), before);
    assert.equal(f.tasks.graph.get(binding.nodeId, f.project.id).status, 'pending_review');
  } finally { f.close(); }
});
