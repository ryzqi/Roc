import {applyOfflineResearchSchema} from './fixtures/offline-migration.mjs';
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {withResearchTestWorker, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
function scene() {
  const f = createResearchFixture(api, 'writing');
  f.repository.knowledge.upsertFromSource({id: 'directness-source', projectId: f.project.id, sourceType: 'file',
    sourceId: 'synthetic-measurement.md', title: 'Synthetic directness source',
    content: 'The measured difference was -4 ms.', chunks: [{content: 'The measured difference was -4 ms.', locator: 'block:2'}],
    embeddingPolicy: 'none'});
  f.source = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'directness-source:chunk:0'});
  f.artifactId = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {title: 'Synthetic manuscript', markdown: 'Saved manuscript',
    claims: [{subjectType: 'paragraph', content: 'The measured difference was -4 ms.', status: 'supported', evidenceIds: [f.source.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'})).outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  f.coverage = () => new api.ResearchCitationCoverageService(f.repository).inspect({
    projectId: f.project.id, artifactId: f.artifactId, expectedHash: null});
  f.request = (overrides = {}) => ({projectId: f.project.id, artifactId: f.artifactId, claimId: f.claim.id,
    evidenceId: f.source.id, requestId: 'review-1', expectedReportHash: f.coverage().reportHash, parent: null,
    directness: 'direct', rationale: 'I compared the entire claim with the retained exact measurement.', ...overrides});
  f.save = (request, windowId = 45) => api.withResearchHumanContext({
    capability: 'research.citationReviews.save', projectId: request.projectId, windowId
  }, () => f.repository.citationReviews.save(request));
  f.history = (overrides = {}) => f.repository.citationReviews.history({
    projectId: f.project.id, artifactId: f.artifactId, claimId: f.claim.id, evidenceId: f.source.id,
    limit: 10, offset: 0, ...overrides});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  const handlers = new Map();
  api.registerResearchCitationReviewCapabilities({pluginId: 'fixture', capabilities: {
    register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}
  }}, f.repository.citationReviews);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
  return f;
}

test('strict citation declaration requires explicit decision and rationale and binds only validated main sender', async () => {
  const f = scene();
  try {
    const request = f.request(), before = f.changes();
    for (const invalid of [{...request, rationale: ''}, {...request, directness: 'confirmed'},
      {...request, actor: {kind: 'user', id: 'forged'}}, {...request, expectedReportHash: null}]) {
      assert.throws(() => api.researchCitationReviewSaveSchema.parse(invalid));
    }
    assert.throws(() => f.repository.citationReviews.save(request), /research_human_required/u);
    assert.throws(() => api.withResearchHumanContext({capability: 'research.ideaPlans.save', projectId: f.project.id, windowId: 45},
      () => f.repository.citationReviews.save(request)), /research_human_required/u);
    assert.throws(() => api.withResearchHumanContext({capability: 'research.citationReviews.save', projectId: 'wrong', windowId: 45},
      () => f.repository.citationReviews.save(request)), /research_human_project_mismatch/u);
    assert.equal((await f.bridge.invoke('research.saveCitationReview', [request])).error.code, 'research_sender_required');
    assert.equal(f.changes(), before);
    const response = await f.bridge.invoke('research.saveCitationReview', [request], 45);
    assert.equal(response.ok, true);
    assert.deepEqual(response.data.snapshot.actor, {kind: 'user', id: 'window:45'});
    assert.deepEqual(response.data.snapshot.material.claim, f.claim);
    assert.deepEqual(response.data.snapshot.material.source.evidence, f.source);
    assert.equal(response.data.snapshot.material.source.evidence.sourceVersion, f.source.sourceVersion);
  } finally {f.close();}
});

test('immutable directness revisions retain negative assessments and replay without writes or support approval', () => {
  const f = scene();
  try {
    const request = f.request(), initial = f.coverage(), first = f.save(request), bytes = JSON.stringify(first);
    const before = f.changes();
    assert.deepEqual(f.save(request), first);
    assert.equal(f.changes(), before);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
    let coverage = f.coverage();
    assert.notEqual(coverage.reportHash, initial.reportHash);
    assert.equal(coverage.report.counts.directCitations, 1);
    assert.equal(coverage.report.counts.humanReviewedCitations, 0);
    assert.equal(coverage.report.counts.unreviewedDirectnessCitations, 0);
    assert.deepEqual(coverage.report.paragraphs[0].citations[0].directnessReview, {current: true, receipt: first});
    const secondRequest = f.request({requestId: 'review-2', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash},
      directness: 'unsupported', rationale: 'The stated inference exceeds this source measurement.'});
    const second = f.save(secondRequest);
    assert.equal(second.snapshot.version, 2);
    coverage = f.coverage();
    assert.equal(coverage.report.counts.directCitations, 0);
    assert.equal(coverage.report.counts.unsupportedCitations, 1);
    assert.ok(coverage.report.paragraphs[0].issues.some(i => i.kind === 'unsupported_citation'));
    const third = f.save(f.request({requestId: 'review-3', parent: {reviewId: second.snapshot.id, reviewHash: second.snapshotHash},
      directness: 'indirect', rationale: 'The source provides contextual support, with an additional inference required.'}));
    assert.equal(f.coverage().report.counts.indirectCitations, 1);
    assert.equal(JSON.stringify(first), bytes);
    assert.deepEqual(f.history({limit: 2}).items, [third, second]);
    assert.deepEqual(f.history({limit: 2, offset: 2}), {verification: 'stored_receipt', items: [first], total: 3});
    assert.equal(f.coverage().report.counts.humanReviewedCitations, 0);
  } finally {f.close();}
});

test('saved directness changes invalidate the whole artifact review context while preserving human support separately', () => {
  const f = scene();
  try {
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
    const versions = [{artifactId: f.artifactId, version: f.repository.inspectArtifact({
      projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null}).snapshot.version}];
    const first = f.save(f.request());
    assert.throws(() => f.repository.assertArtifactReview({
      projectId: f.project.id, expectedStage: 'writing', expectedArtifactVersions: versions}), /research_artifact_review_changed/u);
    const snapshot = f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null}).snapshot;
    assert.deepEqual(snapshot.citationReviews, [{reviewId: first.snapshot.id, reviewHash: first.snapshotHash,
      claimId: f.claim.id, evidenceId: f.source.id, version: 1, directness: 'direct', recordedAt: first.snapshot.recordedAt}]);
    f.repository.assertArtifactReview({projectId: f.project.id, expectedStage: 'writing',
      expectedArtifactVersions: [{artifactId: f.artifactId, version: snapshot.version}]});
    const relation = f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id})[0];
    f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id,
      expectedVersion: relation.version, expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest,
      decision: 'confirm', note: 'The human separately confirmed semantic support.'}, {kind: 'user', id: 'window:45'});
    const coverage = f.coverage();
    assert.equal(coverage.report.counts.directCitations, 1);
    assert.equal(coverage.report.counts.humanReviewedCitations, 1);
    assert.equal(coverage.report.paragraphs[0].citations[0].directnessReview.current, true);
  } finally {f.close();}
});

test('request identity, report version, parent chain and project boundaries reject conflicting writes', async () => {
  const f = scene();
  try {
    const request = f.request(), first = f.save(request);
    const other = f.repository.createProject({title: 'Other project', description: 'Separate scope', workspacePath: '/tmp/roc-citation-other'});
    const before = f.changes();
    assert.throws(() => f.save({...request, rationale: 'Changed retry body'}), /research_citation_review_request_conflict/u);
    assert.throws(() => f.save(request, 46), /research_citation_review_request_conflict/u);
    assert.throws(() => f.save({...request, requestId: 'stale'}), /research_citation_review_report_changed/u);
    assert.throws(() => f.save(f.request({requestId: 'parentless'})), /research_citation_review_version_conflict/u);
    assert.throws(() => f.save(f.request({requestId: 'wrongparent', parent: {reviewId: first.snapshot.id, reviewHash: '0'.repeat(64)}})),
      /research_citation_review_version_conflict/u);
    assert.throws(() => f.save({...request, projectId: other.id}), /research_citation_review_project_mismatch/u);
    assert.throws(() => f.history({projectId: other.id}), /research_citation_review_project_mismatch/u);
    const response = await f.bridge.invoke('research.saveCitationReview', [{...request, requestId: 'ipc-stale'}], 45);
    assert.equal(response.error.code, 'research_citation_review_report_changed');
    assert.equal(f.changes(), before);
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
    assert.throws(() => f.save(f.request({requestId: 'approved'})), /research_artifact_immutable/u);
    assert.deepEqual(f.history().items, [first]);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.throws(() => f.save(request), /research_project_archived/u);
    assert.deepEqual(f.history().items, [first]);
  } finally {f.close();}
});

test('claim revision marks prior directness stale and source invalidation preserves honest stored history', () => {
  const f = scene();
  try {
    const request = f.request(), first = f.save(request);
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
      content: 'The measurement implies a broader synthetic inference.', status: 'supported', evidenceIds: [f.source.id]});
    f.repository.manuscripts.saveManuscript({artifactId: f.artifactId, sections: [{title: 'Results', claimIds: [f.claim.id]}]});
    const coverage = f.coverage();
    assert.deepEqual(coverage.report.paragraphs[0].citations[0].directnessReview, {current: false, receipt: first});
    assert.equal(coverage.report.counts.directCitations, 0);
    assert.equal(coverage.report.counts.unreviewedDirectnessCitations, 1);
    assert.ok(coverage.report.paragraphs[0].issues.some(i => i.kind === 'changed_directness'));
    assert.throws(() => f.save(request), /research_citation_review_source_changed/u);
    assert.throws(() => api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]),
      /research_citation_review_source_changed/u);
    const second = f.save(f.request({requestId: 'revised', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash},
      directness: 'indirect', rationale: 'This revised wording requires an inference beyond the measured value.'}));
    f.repository.evidence.invalidateChunksOf(f.source.documentId);
    assert.throws(() => f.coverage(), /research_evidence_reference_superseded/u);
    assert.deepEqual(f.history().items, [second, first]);
    assert.equal(f.history().verification, 'stored_receipt');
    assert.equal(f.history().items[0].snapshot.material.source.referenceStatus, 'recorded');
  } finally {f.close();}
});

test('export retains all 52 directness revisions without declaring semantic support or promoting verdicts', async () => {
  const f = scene();
  try {
    const first = f.save(f.request());
    let latest = first;
    for (let version = 2; version <= 52; version++) {
      latest = f.save(f.request({requestId: `directness-history-${version}`,
        parent: {reviewId: latest.snapshot.id, reviewHash: latest.snapshotHash}, directness: 'unsupported',
        rationale: `Explicit synthetic revision ${version}`}));
    }
    const before = f.changes();
    const exported = api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]);
    assert.equal(f.changes(), before);
    assert.deepEqual(exported.citationReviews[0].current, [latest]);
    assert.equal(exported.citationReviews[0].history[0].history.total, 52);
    assert.deepEqual(exported.citationReviews[0].history[0].history.items.map(item => item.snapshot.version),
      Array.from({length: 52}, (_, i) => 52 - i));
    assert.equal(exported.citationReviews[0].current[0].snapshot.request.directness, 'unsupported');
    assert.equal(f.coverage().report.counts.humanReviewedCitations, 0);
    const scientificReviews = new api.ResearchArtifactScientificReviewService(f.repository,
      {evidence: async () => assert.fail('citation declaration has no numeric byte mapping')},
      {verify: async () => assert.fail('manuscript has no plotted mapping')});
    await scientificReviews.verifyArtifacts(f.project.id, [f.artifactId]);
  } finally {f.close();}
});

test('removed citation pairs remain historical without blocking a manuscript that no longer uses them', () => {
  const f = scene();
  try {
    const first = f.save(f.request());
    f.repository.knowledge.upsertFromSource({id: 'replacement-source', projectId: f.project.id, sourceType: 'file',
      sourceId: 'replacement.md', title: 'Replacement synthetic source', content: 'Replacement measurement.',
      chunks: [{content: 'Replacement measurement.', locator: 'block:1'}], embeddingPolicy: 'none'});
    const replacement = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'replacement-source:chunk:0'});
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
      content: 'Replacement measurement.', status: 'supported', evidenceIds: [replacement.id]});
    f.repository.manuscripts.saveManuscript({artifactId: f.artifactId, sections: [{title: 'Results', claimIds: [f.claim.id]}]});
    const exported = api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]);
    assert.deepEqual(exported.citationReviews[0].current, []);
    assert.deepEqual(exported.citationReviews[0].history[0].history.items, [first]);
    assert.deepEqual(api.currentArtifactScientificReviews(f.repository, f.project.id, f.artifactId).citations, []);
  } finally {f.close();}
});

test('persisted timeline survives disk reopening and detects damaged bytes, indexes and parent anchors', async () => {
  const f = scene(), directory = mkdtempSync(join(tmpdir(), 'roc-citation-disk-'));
  let db;
  try {
    const first = f.save(f.request());
    const second = f.save(f.request({requestId: 'second', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash},
      directness: 'indirect', rationale: 'A synthetic inference is required.'}));
    const file = join(directory, 'research.db');
    await f.db.backup(file);
    db = new Database(file);
    db.pragma('foreign_keys=ON');
    const reopened = new api.ResearchRepository(db, f.tasks, () => '2026-11-06T00:00:00.000Z');
    const input = {projectId: f.project.id, artifactId: f.artifactId, claimId: f.claim.id, evidenceId: f.source.id, limit: 10, offset: 0};
    assert.deepEqual(reopened.citationReviews.history(input).items, [second, first]);
    assert.equal(new api.ResearchCitationCoverageService(reopened).inspect({
      projectId: f.project.id, artifactId: f.artifactId, expectedHash: null}).report.counts.indirectCitations, 1);
    db.prepare('UPDATE research_citation_reviews SET snapshot_hash=? WHERE id=?').run('0'.repeat(64), first.snapshot.id);
    assert.throws(() => reopened.citationReviews.history({...input, limit: 1}), /research_citation_review_snapshot_invalid/u);
    db.prepare('UPDATE research_citation_reviews SET snapshot_hash=? WHERE id=?').run(first.snapshotHash, first.snapshot.id);
    db.prepare('UPDATE research_citation_reviews SET created_at=? WHERE id=?').run('2026-11-06T00:00:00.000Z', second.snapshot.id);
    assert.throws(() => reopened.citationReviews.history(input), /research_citation_review_snapshot_invalid/u);
    db.prepare('UPDATE research_citation_reviews SET created_at=? WHERE id=?').run(second.snapshot.recordedAt, second.snapshot.id);
    db.prepare('UPDATE research_citation_reviews SET snapshot_json=? WHERE id=?').run('{}', second.snapshot.id);
    assert.throws(() => reopened.citationReviews.history(input));
  } finally {db?.close(); f.close(); rmSync(directory, {recursive: true, force: true});}
});

test('DB47 is append-only, preserves previous migration receipts and installs timeline constraints', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    const previous = api.researchMigrations.filter(m => m.version <= 46);
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: previous});
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    applyOfflineResearchSchema(api, db);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=46 ORDER BY version').all(), ledger);
    assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=47").pluck().get(), 'human_citation_directness_timeline');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='research_citation_reviews'").pluck().get();
    assert.match(sql, /UNIQUE\(claim_id,evidence_id,version\)/u);
    assert.match(sql, /UNIQUE\(project_id,request_id\)/u);
    assert.match(sql, /CHECK\(json_valid\(snapshot_json\)\)/u);
  } finally {db.close();}
});
