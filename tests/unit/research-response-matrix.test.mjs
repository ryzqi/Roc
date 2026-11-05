import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {captureResearchArtifactVersions, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function scene() {
  const f = createResearchFixture(api, 'writing');
  f.repository.knowledge.upsertFromSource({id: 'response-source', projectId: f.project.id, sourceType: 'file',
    sourceId: 'synthetic-measurement.md', title: 'Synthetic measurement',
    content: 'The measured difference was -4 ms.', chunks: [{content: 'The measured difference was -4 ms.', locator: 'block:0'}],
    embeddingPolicy: 'none'});
  f.source = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'response-source:chunk:0'});
  f.artifactId = f.repository.runs.complete(f.run.id, f.project.id, {title: 'Synthetic manuscript', markdown: 'Saved manuscript',
    claims: [{subjectType: 'paragraph', content: 'The measured difference was -4 ms.', status: 'supported', evidenceIds: [f.source.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'}).outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  f.inspect = (expectedHash = null) => f.repository.responseMatrix.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash});
  f.location = () => ({claimId: f.claim.id, claimHash: api.relationClaimHash(f.claim),
    start: 0, end: f.claim.content.length, text: f.claim.content});
  f.row = (overrides = {}) => ({commentId: 'r1-c1', reviewer: 'Reviewer 1', comment: 'Report the signed measured difference.',
    status: 'open', response: '', locations: [], evidenceIds: [], ...overrides});
  f.request = (overrides = {}) => ({projectId: f.project.id, artifactId: f.artifactId, requestId: 'matrix-1',
    expectedArtifactVersion: f.inspect().report.artifactVersion, parent: null, rationale: 'Initial human transcription',
    rows: [f.row()], ...overrides});
  f.save = (request = f.request(), windowId = 52) => api.withResearchHumanContext({
    capability: 'research.responseMatrix.save', projectId: request.projectId, windowId
  }, () => f.repository.responseMatrix.save(request));
  f.history = (overrides = {}) => f.repository.responseMatrix.history({
    projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 10, ...overrides});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  const handlers = new Map();
  api.registerResearchResponseMatrixCapabilities({pluginId: 'fixture', capabilities: {
    register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}
  }}, f.repository.responseMatrix);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
  return f;
}

test('strict human matrix input keeps open comments unhandled and refuses forged completion or authority', async () => {
  const f = scene();
  try {
    const request = f.request(), before = f.changes();
    for (const invalid of [
      {...request, actor: {kind: 'user', id: 'forged'}},
      {...request, rows: [f.row({status: 'complete'})]},
      {...request, rows: [f.row({status: 'addressed', response: 'Updated.'})]},
      {...request, rows: [f.row({status: 'declined'})]},
      {...request, rows: [f.row(), f.row()]}, {...request, rationale: ''},
      {...request, rows: [f.row({evidenceIds: [f.source.id, f.source.id]})]}
    ]) assert.equal(api.researchResponseMatrixSaveSchema.safeParse(invalid).success, false);
    assert.throws(() => f.repository.responseMatrix.save(request), /research_human_required/u);
    assert.throws(() => api.withResearchHumanContext({capability: 'research.consistency.save', projectId: f.project.id, windowId: 52},
      () => f.repository.responseMatrix.save(request)), /research_human_required/u);
    assert.equal((await f.bridge.invoke('research.saveResponseMatrix', [request])).error.code, 'research_sender_required');
    assert.equal(f.changes(), before);
    const saved = await f.bridge.invoke('research.saveResponseMatrix', [request], 52);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.data.snapshot.actor, {kind: 'user', id: 'window:52'});
    assert.deepEqual(f.inspect().report.openCommentIds, ['r1-c1']);
    assert.deepEqual(f.inspect().report.addressedCommentIds, []);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
  } finally {f.close();}
});

test('human addressed and declined revisions bind exact negative text, section, evidence and unchanged original opinions', () => {
  const f = scene();
  try {
    const initial = f.inspect(), firstRequest = f.request(), first = f.save(firstRequest), bytes = JSON.stringify(first);
    const secondRequest = f.request({requestId: 'matrix-2', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash},
      rationale: 'Compared the current revised text with the exact synthetic source.',
      rows: [f.row({status: 'addressed', response: 'Results now reports -4 ms with the measured source.',
        locations: [f.location()], evidenceIds: [f.source.id]}),
        f.row({commentId: 'r2-c1', reviewer: 'Reviewer 2', comment: 'Remove all negative results.',
          status: 'declined', response: 'Negative results remain part of the declared study.', evidenceIds: [f.source.id]})]});
    const second = f.save(secondRequest), before = f.changes();
    assert.deepEqual(f.save(secondRequest), second);
    assert.equal(f.changes(), before);
    assert.equal(second.snapshot.version, 2);
    assert.equal(second.snapshot.material.manuscript.sections[0].title, 'Results');
    assert.deepEqual(second.snapshot.material.claims, [f.claim]);
    assert.deepEqual(second.snapshot.material.evidence[0].evidence, f.source);
    assert.equal(second.snapshotHash, hash(second.snapshot));
    const inspected = f.inspect(initial.reportHash);
    assert.equal(inspected.status, 'stale');
    assert.equal(inspected.report.reviewCurrent, true);
    assert.deepEqual(inspected.report.openCommentIds, []);
    assert.deepEqual(inspected.report.addressedCommentIds, ['r1-c1']);
    assert.deepEqual(inspected.report.declinedCommentIds, ['r2-c1']);
    assert.equal(JSON.stringify(first), bytes);
    assert.deepEqual(f.history({limit: 1}).items, [second]);
    assert.deepEqual(f.history({offset: 1, limit: 1}), {verification: 'stored_receipt', items: [first], total: 2});
    assert.throws(() => f.save(f.request({requestId: 'remove', parent: {reviewId: second.snapshot.id, reviewHash: second.snapshotHash}})),
      /research_response_comment_removed/u);
    assert.throws(() => f.save(f.request({requestId: 'rewrite', parent: {reviewId: second.snapshot.id, reviewHash: second.snapshotHash},
      rows: second.snapshot.request.rows.map(row => ({...row, comment: 'Changed original opinion.'}))})), /research_response_comment_changed/u);
  } finally {f.close();}
});

test('exact locations, latest parent, sender and whole artifact version refuse conflicts without extra writes', async () => {
  const f = scene();
  try {
    const request = f.request(), first = f.save(request), before = f.changes();
    assert.throws(() => f.save({...request, rationale: 'Different retry'}), /research_response_request_conflict/u);
    assert.throws(() => f.save(request, 53), /research_response_request_conflict/u);
    assert.throws(() => f.save(f.request({requestId: 'missing-parent'})), /research_response_version_conflict/u);
    const next = f.request({requestId: 'next', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash},
      rows: [f.row({status: 'addressed', response: 'Explicit response.', locations: [{...f.location(), text: 'Wrong text'}]})]});
    assert.throws(() => f.save(next), /research_response_location_invalid/u);
    assert.throws(() => f.save({...next, rows: [f.row({locations: [{...f.location(), claimHash: '0'.repeat(64)}]})]}),
      /research_response_location_invalid/u);
    assert.throws(() => f.save({...next, expectedArtifactVersion: '0'.repeat(64)}), /research_response_artifact_changed/u);
    const response = await f.bridge.invoke('research.saveResponseMatrix', [next], 52);
    assert.equal(response.error.code, 'research_response_location_invalid');
    assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('failed append leaves the original parent and exact request reusable without phantom completion', () => {
  const f = scene();
  try {
    const first = f.save();
    const request = f.request({requestId: 'after-failure', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash},
      rows: [f.row({status: 'addressed', response: 'Current text contains the signed measurement.', locations: [f.location()]})]});
    f.db.exec("CREATE TEMP TRIGGER fail_response_append BEFORE INSERT ON research_response_matrices BEGIN SELECT RAISE(ABORT,'fixture_append_failure'); END");
    assert.throws(() => f.save(request), /fixture_append_failure/u);
    assert.deepEqual(f.history().items, [first]);
    assert.deepEqual(f.inspect().report.openCommentIds, ['r1-c1']);
    f.db.exec('DROP TRIGGER fail_response_append');
    const second = f.save(request), before = f.changes();
    assert.equal(second.snapshot.version, 2);
    assert.deepEqual(f.save(request), second);
    assert.equal(f.changes(), before);
    assert.deepEqual(f.inspect().report.addressedCommentIds, ['r1-c1']);
  } finally {f.close();}
});

test('exact UTF-16 locations preserve selected whitespace and supplementary characters', () => {
  const f = scene();
  try {
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
      content: 'The measured difference was -4 ms. 𝛥 verified.', status: 'supported', evidenceIds: [f.source.id]});
    f.repository.manuscripts.saveManuscript({artifactId: f.artifactId, sections: [{title: 'Results', claimIds: [f.claim.id]}]});
    const start = f.claim.content.indexOf(' 𝛥'), end = start + ' 𝛥 '.length;
    const location = {...f.location(), start, end, text: f.claim.content.slice(start, end)};
    const saved = f.save(f.request({rows: [f.row({status: 'addressed', response: 'Preserved exact revised notation.',
      locations: [location]})]}));
    assert.equal(saved.snapshot.request.rows[0].locations[0].text, ' 𝛥 ');
    assert.equal(saved.snapshot.request.rows[0].locations[0].end - start, 4);
    assert.equal(f.inspect().report.reviewCurrent, true);
    assert.deepEqual(f.history().items, [saved]);
  } finally {f.close();}
});

test('revised manuscript makes saved mapping stale until explicit rebinding while historical receipt remains exact', () => {
  const f = scene();
  try {
    const first = f.save(f.request({rows: [f.row({status: 'addressed', response: 'Exact initial location.',
      locations: [f.location()], evidenceIds: [f.source.id]})]}));
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
      content: 'Revised text still reports the -4 ms negative difference.', status: 'supported', evidenceIds: [f.source.id]});
    assert.throws(() => f.inspect(), /research_manuscript_stale/u);
    f.repository.manuscripts.saveManuscript({artifactId: f.artifactId, sections: [{title: 'Revised Results', claimIds: [f.claim.id]}]});
    assert.equal(f.inspect().report.reviewCurrent, false);
    assert.throws(() => f.save(first.snapshot.request), /research_response_source_changed/u);
    const second = f.save(f.request({requestId: 'rebind', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash},
      rationale: 'Rebound after explicit text revision.',
      rows: [f.row({status: 'addressed', response: 'Exact revised location.', locations: [f.location()], evidenceIds: [f.source.id]})]}));
    assert.equal(f.inspect().report.reviewCurrent, true);
    f.repository.evidence.invalidateChunksOf(f.source.documentId);
    assert.throws(() => f.inspect(), /research_evidence_reference_superseded/u);
    assert.deepEqual(f.history().items, [second, first]);
    const before = f.changes();
    f.history(); assert.equal(f.changes(), before);
  } finally {f.close();}
});

test('foreign project, inactive stage and archive refuse writes while approved historical reads remain available', () => {
  const f = scene();
  try {
    const request = f.request(), first = f.save(request);
    const other = f.repository.createProject({title: 'Foreign', description: '', workspacePath: '/tmp/foreign-response-matrix'});
    assert.throws(() => f.repository.responseMatrix.inspect({projectId: other.id, artifactId: f.artifactId, expectedHash: null}),
      /research_response_project_mismatch/u);
    assert.throws(() => f.repository.responseMatrix.history({projectId: other.id, artifactId: f.artifactId, offset: 0, limit: 10}),
      /research_response_project_mismatch/u);
    f.db.prepare("UPDATE research_projects SET current_stage='export' WHERE id=?").run(f.project.id);
    assert.throws(() => f.save({...request, requestId: 'inactive'}), /research_artifact_stage_inactive/u);
    f.db.prepare("UPDATE research_projects SET current_stage='writing' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
    assert.throws(() => f.save({...request, requestId: 'approved'}), /research_artifact_immutable/u);
    assert.deepEqual(f.history().items, [first]);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.throws(() => f.save(request), /research_project_archived/u);
    assert.equal(f.inspect().report.reviewCurrent, true);
    assert.deepEqual(f.history().items, [first]);
  } finally {f.close();}
});

test('persisted receipt survives disk reopen and rejects rehashed material and broken parent', () => {
  const f = scene(), directory = mkdtempSync(join(tmpdir(), 'roc-response-matrix-'));
  let db;
  try {
    const first = f.save(), second = f.save(f.request({requestId: 'second',
      parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}, rows: [f.row({response: 'Still being investigated.'})]}));
    f.db.exec(`VACUUM INTO '${join(directory, 'research.db').replaceAll("'", "''")}'`);
    db = new Database(join(directory, 'research.db'));
    const repository = new api.ResearchRepository(db, f.tasks);
    assert.deepEqual(repository.responseMatrix.history({projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 10}).items, [second, first]);
    const damaged = structuredClone(second.snapshot);
    damaged.material.claims[0].content = 'Rehashed fabricated content.';
    db.prepare('UPDATE research_response_matrices SET snapshot_json=?,snapshot_hash=? WHERE id=?')
      .run(JSON.stringify(damaged), hash(damaged), second.snapshot.id);
    assert.throws(() => repository.responseMatrix.latest(f.project.id, f.artifactId), /research_response_snapshot_invalid/u);
    db.prepare('UPDATE research_response_matrices SET snapshot_json=?,snapshot_hash=? WHERE id=?')
      .run(JSON.stringify(second.snapshot), second.snapshotHash, second.snapshot.id);
    db.prepare('UPDATE research_response_matrices SET snapshot_hash=? WHERE id=?').run('0'.repeat(64), first.snapshot.id);
    assert.throws(() => repository.responseMatrix.latest(f.project.id, f.artifactId), /research_response_snapshot_invalid/u);
  } finally {db?.close(); f.close(); rmSync(directory, {recursive: true, force: true});}
});

test('DB49 to50 preserves exact prior migration ledger without inventing response decisions', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(m => m.version <= 49),
      now: () => '2026-11-01T00:00:00.000Z'});
    const prior = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(m => m.version <= 50)});
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=49 ORDER BY version').all(), prior);
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 50);
    assert.equal(db.prepare('SELECT count(*) FROM research_response_matrices').pluck().get(), 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {db.close();}
});

test('matrix head and independently selected evidence bind the whole artifact version without altering claims', () => {
  const f = scene();
  try {
    const inspect = expectedVersion => f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.artifactId, expectedVersion});
    const initial = inspect(null).snapshot;
    assert.equal(initial.responseMatrix, null);
    f.repository.knowledge.upsertFromSource({id: 'response-independent', projectId: f.project.id, sourceType: 'file',
      sourceId: 'independent.md', title: 'Independent synthetic source', content: 'Additional reviewed observation.',
      chunks: [{content: 'Additional reviewed observation.', locator: 'block:0'}], embeddingPolicy: 'none'});
    const independent = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'response-independent:chunk:0'});
    const first = f.save(f.request({rows: [f.row({evidenceIds: [independent.id]})]}));
    const current = inspect(initial.version);
    assert.equal(current.status, 'stale');
    assert.deepEqual(current.snapshot.responseMatrix, {reviewId: first.snapshot.id, reviewHash: first.snapshotHash,
      version: 1, recordedAt: first.snapshot.recordedAt});
    assert.deepEqual(current.snapshot.evidence.map(source => source.evidence.id), [f.source.id, independent.id]);
    assert.deepEqual(current.snapshot.claims, initial.claims);
    const before = f.changes();
    assert.deepEqual(api.currentArtifactScientificReviews(f.repository, f.project.id, f.artifactId).response, first);
    assert.equal(f.changes(), before);
    f.repository.evidence.invalidateChunksOf(independent.documentId);
    assert.equal(inspect(current.snapshot.version).status, 'stale');
    assert.throws(() => api.currentArtifactScientificReviews(f.repository, f.project.id, f.artifactId), /research_response_source_changed/u);
    assert.throws(() => api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]), /research_response_source_changed/u);
    assert.deepEqual(f.history().items, [first]);
  } finally {f.close();}
});

test('human gate requires the shared verifier for response-only reviews and revokes earlier artifact approvals', async () => {
  const f = scene();
  try {
    const missing = api.createResearchHumanGate({repository: f.repository});
    const initial = f.save();
    const before = f.changes();
    await assert.rejects(missing.complete({projectId: f.project.id, expectedStage: 'writing', action: 'complete'}),
      /research_scientific_review_verify_unavailable/u);
    assert.equal(f.changes(), before);
    const scientificReviews = new api.ResearchArtifactScientificReviewService(f.repository,
      {evidence: async () => assert.fail('no selected response Evidence')},
      {verify: async () => assert.fail('manuscript has no plotted review')});
    const gate = api.createResearchHumanGate({repository: f.repository, scientificReviews});
    await gate.complete({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
    const prior = captureResearchArtifactVersions(f.repository, f.project.id);
    f.save(f.request({requestId: 'new-human-reply', parent: {reviewId: initial.snapshot.id, reviewHash: initial.snapshotHash},
      rows: [f.row({status: 'declined', response: 'Explicitly retain the signed negative result.'})]}));
    const changes = f.changes();
    await assert.rejects(gate.approve({projectId: f.project.id, expectedStage: 'writing', action: 'approve',
      expectedArtifactVersions: prior}), /research_artifact_review_changed/u);
    assert.equal(f.changes(), changes);
    const relation = f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id})[0];
    f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
      expectedClaimVersion: f.claim.version, expectedSourceDigest: relation.sourceDigest, decision: 'confirm',
      note: 'Explicit synthetic support review'}, {kind: 'user', id: 'window:52'});
    await gate.approve({projectId: f.project.id, expectedStage: 'writing', action: 'approve',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'approved');
    assert.equal(f.history().items[0].snapshot.request.rows[0].status, 'declined');
  } finally {f.close();}
});

test('shared currentness refuses a changed manuscript while preserving the original addressed history', () => {
  const f = scene();
  try {
    const first = f.save(f.request({rows: [f.row({status: 'addressed', response: 'Verified exact text.', locations: [f.location()]})]}));
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
      content: 'The revised negative result differs.', status: 'supported', evidenceIds: [f.source.id]});
    assert.throws(() => api.currentArtifactScientificReviews(f.repository, f.project.id, f.artifactId), /research_manuscript_stale/u);
    f.repository.manuscripts.saveManuscript({artifactId: f.artifactId, sections: [{title: 'Results', claimIds: [f.claim.id]}]});
    assert.throws(() => api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]), /research_response_source_changed/u);
    assert.deepEqual(f.history().items, [first]);
  } finally {f.close();}
});

test('async response evidence verification refuses newer matrix, source and project changes before acceptance', async () => {
  for (const mutation of ['matrix', 'source', 'project']) {
    const f = scene();
    try {
      const first = f.save(f.request({rows: [f.row({evidenceIds: [f.source.id]})]}));
      let called = 0;
      const verifier = new api.ResearchArtifactScientificReviewService(f.repository, {evidence: async request => {
        assert.deepEqual(request, {projectId: f.project.id, evidenceId: f.source.id});
        called++;
        if (mutation === 'matrix') f.save(f.request({requestId: 'during-await',
          parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}, rows: [f.row({evidenceIds: [f.source.id], response: 'New human context.'})]}));
        if (mutation === 'source') f.repository.evidence.invalidateChunksOf(f.source.documentId);
        if (mutation === 'project') f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
        return null; // Ordinary file Evidence has no executed metric trace.
      }}, {verify: async () => assert.fail('no plotted review')});
      await assert.rejects(verifier.verifyArtifacts(f.project.id, [f.artifactId]),
        mutation === 'source' ? /research_evidence_reference_superseded/u : /research_artifact_review_changed/u);
      assert.equal(called, 1);
      assert.deepEqual(f.history().items.at(-1), first);
    } finally {f.close();}
  }
});

test('response export carries all 102 stored revisions and refuses incomplete intermediate pages', () => {
  const f = scene();
  try {
    const first = f.save();
    let latest = first;
    for (let version = 2; version <= 102; version++) latest = f.save(f.request({
      requestId: `response-history-${version}`, parent: {reviewId: latest.snapshot.id, reviewHash: latest.snapshotHash},
      rows: [f.row({response: `Explicit human investigation ${version}`})]
    }));
    const before = f.changes(), exported = api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]);
    assert.deepEqual(exported.responseMatrices[0].current, latest);
    assert.equal(exported.responseMatrices[0].history.verification, 'stored_receipt');
    assert.deepEqual(exported.responseMatrices[0].history.items.map(item => item.snapshot.version),
      Array.from({length: 102}, (_, index) => 102 - index));
    assert.deepEqual(exported.responseMatrices[0].history.items.at(-1), first);
    assert.equal(exported.responseMatrices[0].current.snapshot.request.rows[0].status, 'open');
    assert.equal(f.changes(), before);
    const history = f.repository.responseMatrix.history.bind(f.repository.responseMatrix);
    f.repository.responseMatrix.history = request => request.offset === 0 ? history(request) :
      {verification: 'stored_receipt', items: [], total: 102};
    assert.throws(() => api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]), /research_export_review_history_changed/u);
  } finally {f.close();}
});

test('schema5 export seal captures response-only evidence and changes after independent human response revisions', () => {
  const f = scene();
  try {
    const relation = f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id})[0];
    f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
      expectedClaimVersion: f.claim.version, expectedSourceDigest: relation.sourceDigest, decision: 'confirm',
      note: 'Explicit synthetic support review'}, {kind: 'user', id: 'window:52'});
    f.repository.knowledge.upsertFromSource({id: 'export-response-source', projectId: f.project.id, sourceType: 'file',
      sourceId: 'response-source.md', title: 'Additional response source', content: 'Additional exact observation.',
      chunks: [{content: 'Additional exact observation.', locator: 'block:0'}], embeddingPolicy: 'none'});
    const independent = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'export-response-source:chunk:0'});
    const first = f.save(f.request({rows: [f.row({evidenceIds: [independent.id]})]}));
    const sources = {project: f.project, manuscriptArtifact: f.repository.getArtifact(f.artifactId),
      figures: [], claims: [f.claim], evidence: [f.source], experimentResults: [], ideaOutcomes: []};
    const review = api.captureExportScientificReview(f.repository, sources), bytes = api.serializeExportScientificReview(review);
    const publicBytes = api.serializePublicExportScientificReview(review);
    assert.equal(review.schemaVersion, 5);
    assert.deepEqual(review.responseMatrices[0].current, first);
    assert.deepEqual(review.evidence.map(source => source.evidence.id), [f.source.id, independent.id]);
    assert.equal(api.researchExportScientificReviewSchema.safeParse({...review, schemaVersion: 3}).success, false);
    assert.equal(api.researchExportScientificReviewSchema.safeParse({...review, responseMatrices: undefined}).success, false);
    const record = {sources, sourceHash: review.sourceHash, files: [{path: api.exportScientificReviewPath,
      size: Buffer.byteLength(publicBytes), sha256: createHash('sha256').update(publicBytes).digest('hex')}]};
    const before = f.changes();
    api.assertCurrentExportScientificReview(f.repository, record);
    assert.equal(f.changes(), before);
    f.save(f.request({requestId: 'seal-revision', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash},
      rows: [f.row({evidenceIds: [independent.id], response: 'New explicit investigation.'})]}));
    assert.throws(() => api.assertCurrentExportScientificReview(f.repository, record),
      error => error.code === 'research_export_semantic_snapshot_changed');
    assert.equal(api.serializeExportScientificReview(review), bytes);
  } finally {f.close();}
});
