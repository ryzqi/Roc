import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createScientificReviewFixture} from './fixtures/scientific-review.mjs';
import {syntheticExportPublicationReview} from '../fixtures/research-export-publication.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const entry = (path, bytes) => ({path, sha256: hash(bytes), size: Buffer.byteLength(bytes)});

function material(f) {
  const bundle = f.repository.manuscripts.exportBundle({projectId: f.project.id, artifactId: f.artifactId});
  const sources = {project: f.project, manuscriptArtifact: f.repository.getArtifact(f.artifactId),
    manuscript: bundle.manuscript, claims: bundle.claims, evidence: bundle.evidence,
    figures: [], modelRuns: [f.repository.runs.get(f.run.id, f.project.id)], experiments: [],
    experimentResults: [], ideaOutcomes: [], bibliography: [], template: null};
  const request = {publicationReview: syntheticExportPublicationReview({sourceHash: hash(JSON.stringify(sources)), resources: [], references: []})};
  const files = [entry('paper.pdf', 'unit compiler receipt'), entry('report.pdf', 'unit report receipt'),
    entry(api.exportScientificReviewPath, api.serializePublicExportScientificReview(api.captureExportScientificReview(f.repository, sources)))];
  return {sources, request, files};
}

for (const verdict of ['unrelated', 'unable_to_verify']) {
  test(`${verdict} survives persisted review, inspection and export sealing without changing human decisions`, () => {
    const f = createScientificReviewFixture(api, {verifierVerdict: verdict});
    try {
      const relations = f.repository.evidence.relations.forArtifact(f.artifactId, f.project.id);
      f.complete();
      const reports = f.repository.scientificReviews.reportsForManuscript(f.project.id, f.artifactId);
      const report = reports.find(item => item.output.kind === 'verifier');
      assert.equal(report.status, 'current');
      assert.equal(report.output.suggestions[0].verdict, verdict);
      const {sources, request, files} = material(f);
      const value = api.captureExportValidation(f.repository, sources, request, files);
      const bytes = api.serializeResearchPublicProjection(value);
      const publicValue = JSON.parse(bytes);
      assert.equal(publicValue.value.semanticReports.find(item => item.output.kind === 'verifier').output.suggestions[0].verdict, verdict);
      assert.equal(hash(JSON.stringify(publicValue.value)), publicValue.projectionSha256);
      assert.equal(value.claims[0].adviceStatus, 'requires_human_review');
      assert.equal(value.claims[0].humanConfirmedRelationIds.length, 1);
      api.assertCurrentExportReviews(f.repository, {sources, request, sourceHash: value.sourceHash,
        files: [...files, entry(api.exportValidationPath, bytes)]});
      assert.deepEqual(f.repository.evidence.relations.forArtifact(f.artifactId, f.project.id), relations);
      assert.throws(() => f.repository.scientificReviews.requireFindingDispositions(f.project.id, f.artifactId), /findings_unhandled/);
    } finally {f.close();}
  });
}

test('validation keeps missing semantic advice explicit, then seals real reports and historical Skill pins', () => {
  const f = createScientificReviewFixture(api);
  try {
    const missing = material(f);
    const initial = api.captureExportValidation(f.repository, missing.sources, missing.request, missing.files);
    assert.equal(initial.claims[0].adviceStatus, 'missing_current_verifier');
    assert.equal(initial.claims[0].humanConfirmedRelationIds.length, 1);
    assert.equal(initial.semanticReports.length, 0);
    f.complete();
    const {sources, request, files} = material(f);
    const value = api.captureExportValidation(f.repository, sources, request, files);
    assert.equal(value.semanticAuthority, 'model_suggestion_requires_human_review');
    assert.equal(value.claims[0].adviceStatus, 'requires_human_review');
    assert.equal(value.semanticReports.length, 3);
    const verifier = value.semanticReports.find(report => report.output.kind === 'verifier');
    assert.equal(verifier.output.suggestions[0].negativeResults[0].quote, f.evidence.excerpt);
    assert.ok(value.semanticReports.every(report => report.status === 'current'));
    for (const run of value.runs) assert.deepEqual(run.skillPin, f.repository.runs.getContext(run.runId).skillPin);
    const bytes = api.serializeResearchPublicProjection(value);
    const record = {sources, sourceHash: value.sourceHash, request, files: [...files, entry(api.exportValidationPath, bytes)]};
    api.assertCurrentExportReviews(f.repository, record);
    assert.throws(() => api.assertCurrentExportValidation(f.repository, {...record, files}), error => error.code === 'research_export_validation_required');
    assert.throws(() => api.assertCurrentExportValidation(f.repository, {...record, files: record.files.map(file =>
      file.path === api.exportValidationPath ? {...file, sha256: '0'.repeat(64)} : file)}), error => error.code === 'research_export_validation_changed');
    // A newly captured source changes reviewer coverage without changing any exported claim or source bytes.
    f.repository.knowledge.upsertFromSource({id: 'additional-source', projectId: f.project.id, sourceType: 'file',
      sourceId: 'new.md', title: 'Additional evidence', content: 'A new negative result.',
      chunks: [{content: 'A new negative result.', locator: 'block:0'}], embeddingPolicy: 'none'});
    f.repository.evidence.capture({projectId: f.project.id, chunkId: 'additional-source:chunk:0'});
    api.assertCurrentExportScientificReview(f.repository, record);
    assert.throws(() => api.assertCurrentExportReviews(f.repository, record), error => error.code === 'research_export_validation_changed');
    const changed = api.captureExportValidation(f.repository, sources, request, files);
    assert.equal(changed.claims[0].adviceStatus, 'missing_current_verifier');
    assert.ok(changed.semanticReports.every(report => report.status === 'stale' && report.reasons.includes('evidence_or_source_changed')));
    assert.equal(api.serializeResearchPublicProjection(value), bytes, 'the historical seal stays immutable');
    const publicValue = JSON.parse(bytes);
    assert.equal(hash(JSON.stringify(publicValue.value)), publicValue.projectionSha256);
    assert.equal(value.externalPublication, 'not_performed_by_export');
  } finally {f.close();}
});
