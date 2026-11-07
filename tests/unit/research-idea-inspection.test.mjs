import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {withResearchTestWorker, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {ideaCanvasContentFixture, ideaPlanBodyFixture} from './fixtures/research-idea-plan.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());

test('actual human review snapshot includes Canvas and plan methods, freeze and evidence drift without timestamp aliases', () => {
  const f = createResearchFixture(api, 'ideation');
  try {
    const run = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {
      title: 'Testable synthetic hypothesis', markdown: 'Synthetic idea', claims: [], sections: [], verdict: 'uncertain',
      ideaCanvas: ideaCanvasContentFixture()
    }));
    const artifactId = run.outputArtifactIds[0], canvas = f.repository.ideas.get(artifactId);
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'ideation', action: 'complete'});
    const request = {projectId: f.project.id, artifactId, expectedVersion: null};
    const baseline = f.repository.inspectArtifact(request);
    assert.deepEqual(baseline.snapshot.ideaCanvas, canvas);
    assert.equal(baseline.snapshot.ideaPlan, null);
    const gate = f.repository.readGateReviewContext({projectId: f.project.id, expectedStage: 'ideation', artifactId});
    const approval = {projectId: f.project.id, expectedStage: 'ideation',
      expectedArtifactVersions: gate.artifactLinks.map(link => ({artifactId: link.artifactId, version: link.expectedVersion}))};
    f.repository.assertArtifactReview(approval);
    const save = request => api.withResearchHumanContext({capability: 'research.ideaPlans.save', projectId: f.project.id, windowId: 74},
      () => f.repository.ideaPlans.save(request));
    const first = save({projectId: f.project.id, artifactId, requestId: 'plan-v1',
      canvas: {version: canvas.version, contentHash: canvas.contentHash}, parent: null, revisionReason: null,
      body: ideaPlanBodyFixture()});
    const saved = f.repository.inspectArtifact({...request, expectedVersion: baseline.snapshot.version});
    assert.equal(saved.status, 'stale');
    assert.deepEqual(saved.snapshot.ideaPlan, first);
    assert.throws(() => f.repository.assertArtifactReview(approval), /research_artifact_review_changed/u);
    const frozen = api.withResearchHumanContext({capability: 'research.ideaPlans.freeze', projectId: f.project.id, windowId: 74},
      () => f.repository.ideaPlans.freeze({projectId: f.project.id, artifactId, versionId: first.version.id,
        expectedHash: first.versionHash, requestId: 'freeze-v1', reviewNote: 'Synthetic human review'}));
    const withFreeze = f.repository.inspectArtifact({...request, expectedVersion: saved.snapshot.version});
    assert.equal(withFreeze.status, 'stale');
    assert.equal(withFreeze.snapshot.ideaPlan.freezeHash, frozen.freezeHash);
    f.repository.knowledge.upsertFromSource({id: 'observed-negative', projectId: f.project.id, sourceType: 'file',
      sourceId: 'synthetic-negative.txt', title: 'Negative observation', content: 'Observed difference: +2 ms',
      chunks: [{content: 'Observed difference: +2 ms', locator: 'line:1'}], embeddingPolicy: 'none'});
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'observed-negative:chunk:0'});
    save({...first.version.request, requestId: 'plan-v2', parent: {versionId: first.version.id, versionHash: first.versionHash},
      revisionReason: 'Observed outcome contradicts the prediction',
      body: {...first.version.request.body, observation: {kind: 'after_data', evidenceIds: [evidence.id]}}});
    const observed = f.repository.inspectArtifact(request);
    assert.equal(observed.snapshot.evidence[0].evidence.id, evidence.id);
    assert.equal(observed.snapshot.ideaPlan.version.request.body.metrics[0].expectedOutcome, 'A negative mean difference');
    f.repository.evidence.invalidateEvidence(evidence.id, f.project.id);
    const invalidated = f.repository.inspectArtifact({...request, expectedVersion: observed.snapshot.version});
    assert.equal(invalidated.status, 'stale');
    assert.equal(invalidated.snapshot.evidence[0].referenceStatus, 'superseded');
    assert.equal(invalidated.snapshot.evidence[0].evidence.excerpt, 'Observed difference: +2 ms');
    assert.deepEqual(f.repository.ideaPlans.get({projectId: f.project.id, artifactId, versionId: first.version.id,
      expectedHash: first.versionHash}).version, first.version);
  } finally {f.close();}
});
