import {applyOfflineResearchSchema} from './fixtures/offline-migration.mjs';
import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {withResearchTestWorker, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rule = () => ({conversion: {kind: 'identity'}, rounding: {kind: 'none'},
  tolerance: {absolute: 0, relative: 0, rationale: 'Exact recorded decimal measurement'}});
function calculation(value, text, overrides = {}) {
  const binding = {claimId: 'claim', expectedClaimHash: 'a'.repeat(64), surface: 'body',
    start: 0, end: text.length, unit: 'ms', evidenceId: 'evidence', resultId: 'result', resultHash: 'b'.repeat(64),
    metricId: 'mean', rule: rule(), ...overrides};
  return api.calculateConsistency(binding, text, {snapshot: {
    result: {metrics: [{id: 'mean', value, unit: 'ms'}]}, request: {definitions: [{id: 'mean', unit: 'ms'}]}
  }});
}
function scene() {
  const f = createResearchFixture(api, 'writing');
  const experiment = f.repository.experiments.create({projectId: f.project.id, ownerRunId: null, requestId: 'measurement',
    label: 'Stored synthetic measurement', engine: 'typescript', sourceVersion: 1, sourcePath: 'analysis.mts', inputPaths: [],
    parameters: {}, runtime: {kind: 'bundled-node'}, timeoutMs: 1000, network: 'disabled'},
  '/tmp/roc-research-fixture', '/tmp/roc-research-fixture', '/tmp/roc-synthetic-results');
  const unavailable = {kind: 'unavailable', reason: 'Synthetic contract fixture'};
  const snapshot = {schemaVersion: 1, id: 'fixed-result', request: {
    projectId: f.project.id, requestId: 'reviewed-result', runId: experiment.id, expectedInputHash: 'a'.repeat(64),
    resultPath: 'metrics.json', expectedResultHash: 'b'.repeat(64),
    definitions: [{id: 'mean', label: 'Mean', definition: 'Recorded synthetic mean', unit: 'ms', direction: 'lower'}],
    method: {name: 'Arithmetic mean', rationale: 'All observations', assumptions: 'Synthetic sample', limitations: 'No inference'}},
  actor: {kind: 'user', id: 'window:90'}, recordedAt: '2026-11-03T00:00:00.000Z',
  result: {schemaVersion: 1, metrics: [{id: 'mean', value: -2.345, unit: 'ms', sampleSize: 3,
    uncertainty: unavailable, confidenceInterval: unavailable, effect: unavailable}]},
  execution: {runId: experiment.id, inputHash: 'a'.repeat(64), engine: 'typescript', environmentHash: 'c'.repeat(64),
    source: {area: 'input', path: 'analysis.mts', sha256: 'd'.repeat(64), size: 5},
    output: {area: 'output', path: 'metrics.json', sha256: 'b'.repeat(64), size: 10}, inputs: [],
    parameters: {}, arguments: [], seed: null}};
  f.result = f.repository.experimentResults.save({snapshot, snapshotHash: hash(snapshot)});
  f.evidence = f.repository.experimentResults.captureMetric(f.result, 'mean');
  f.artifactId = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {title: 'Measured values',
    markdown: 'Synthetic measured value report', claims: [
      {subjectType: 'paragraph', content: 'Mean -2.35 ms and comparison 17 ms.', status: 'supported', evidenceIds: [f.evidence.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'})).outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  f.service = new api.ResearchConsistencyService(f.repository, {evidence: async () => ({receipt: f.result, metricId: 'mean'})});
  f.inspect = (expectedHash = null) => f.service.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash});
  f.request = (overrides = {}) => ({projectId: f.project.id, artifactId: f.artifactId, requestId: 'mapping',
    expectedArtifactVersion: f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null}).snapshot.version,
    parent: null, rationale: 'Exact location and explicit rounded synthetic measurement',
    bindings: [{claimId: f.claim.id, expectedClaimHash: api.relationClaimHash(f.claim), surface: 'body',
      start: 5, end: 10, unit: 'ms', evidenceId: f.evidence.id, resultId: f.result.snapshot.id, resultHash: f.result.snapshotHash,
      metricId: 'mean', rule: {...rule(), rounding: {kind: 'decimal_places', places: 2, mode: 'half_away_from_zero'}}}],
    ...overrides});
  f.save = (request = f.request(), windowId = 90) => api.withResearchHumanContext({
    capability: 'research.consistency.save', projectId: request.projectId, windowId}, () => f.service.save(request));
  f.history = (offset = 0, limit = 10) => f.repository.consistency.history({projectId: f.project.id, artifactId: f.artifactId, offset, limit});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}
test('explicit conversion rounding and tolerance preserve negative ties and reject partial tokens units and nonfinite ranges', () => {
  assert.equal(calculation(-2.345, '-2.35', {rule: {...rule(), rounding: {kind: 'decimal_places', places: 2, mode: 'half_away_from_zero'}}}).consistent, true);
  assert.equal(calculation(2.345, '2.35', {rule: {...rule(), rounding: {kind: 'decimal_places', places: 2, mode: 'half_away_from_zero'}}}).expectedText, '2.35');
  assert.equal(calculation(-0.0005, '-0.001', {unit: 's', rule: {...rule(),
    conversion: {kind: 'affine', fromUnit: 'ms', toUnit: 's', scale: 1, offset: 0, rationale: 'Explicit synthetic scale'},
    rounding: {kind: 'decimal_places', places: 3, mode: 'half_away_from_zero'}}}).consistent, true);
  assert.equal(calculation(1000, '1', {unit: 's', rule: {...rule(),
    conversion: {kind: 'affine', fromUnit: 'ms', toUnit: 's', scale: 0.001, offset: 0, rationale: 'Milliseconds divided by one thousand'}}}).consistent, true);
  assert.equal(calculation(-2, '-2.01', {rule: {...rule(), tolerance: {absolute: 0.02, relative: 0, rationale: 'Declared absolute tolerance'}}}).consistent, true);
  assert.equal(calculation(-2, '-2.2', {rule: {...rule(), tolerance: {absolute: 0, relative: 0.01, rationale: 'One percent relative tolerance'}}}).consistent, false);
  assert.equal(calculation(0, '0.1', {rule: {...rule(), tolerance: {absolute: 0, relative: 10, rationale: 'Relative tolerance uses expected zero'}}}).consistent, false);
  assert.throws(() => calculation(2, '2', {unit: 's'}), /research_consistency_unit_mismatch/u);
  assert.throws(() => calculation(-2, '-2', {start: 1}), /research_consistency_span_invalid/u);
  assert.throws(() => calculation(1e308, '1', {rule: {...rule(), conversion: {kind: 'affine',
    fromUnit: 'ms', toUnit: 'ms', scale: 1e308, offset: 0, rationale: 'Invalid overflow'}}}), /research_consistency_calculation_range/u);
});
test('immutable source-bound mappings replay without writes invalidate gate version and expose every unmapped numeric span', async () => {
  const f = scene();
  try {
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
    const initial = await f.inspect(), request = f.request(), saved = await f.save(request), bytes = JSON.stringify(saved);
    const before = f.changes();
    assert.deepEqual(await f.save(request), saved); assert.equal(f.changes(), before);
    const inspected = await f.inspect(initial.reportHash);
    assert.equal(inspected.status, 'stale');
    assert.deepEqual(inspected.report.counts, {mapped: 1, consistent: 1, inconsistent: 0, changed: 0, unmappedClaims: 1, unmappedValues: 1});
    assert.deepEqual(inspected.report.unmappedLocations, [{claimId: f.claim.id, start: 29, end: 31, text: '17'}]);
    assert.notEqual(inspected.report.artifactVersion, request.expectedArtifactVersion);
    assert.throws(() => f.repository.assertArtifactReview({projectId: f.project.id, expectedStage: 'writing',
      expectedArtifactVersions: [{artifactId: f.artifactId, version: request.expectedArtifactVersion}]}), /research_artifact_review_changed/u);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
    const second = await f.save(f.request({requestId: 'second', parent: {reviewId: saved.snapshot.id, reviewHash: saved.snapshotHash},
      bindings: [{...request.bindings[0], start: 29, end: 31, surface: 'table'}]}));
    assert.equal(second.snapshot.material[0].calculation.consistent, false);
    assert.equal((await f.inspect()).report.counts.inconsistent, 1);
    assert.deepEqual(f.history(0, 1).items, [second]); assert.deepEqual(f.history(1, 1).items, [saved]);
    assert.equal(JSON.stringify(saved), bytes);
  } finally {f.close();}
});
test('strict inputs human scope current claim latest parent and archived or approved states reject without writes', async () => {
  const f = scene();
  try {
    const request = f.request();
    for (const value of [{...request, actor: {kind: 'user', id: 'forged'}}, {...request, bindings: []},
      {...request, expectedArtifactVersion: null}, {...request, bindings: [request.bindings[0], request.bindings[0]]},
      {...request, bindings: [{...request.bindings[0], rule: {...rule(), tolerance: {absolute: -1, relative: 0, rationale: 'invalid'}}}]}]) {
      assert.equal(api.researchConsistencySaveSchema.safeParse(value).success, false);
    }
    await assert.rejects(f.service.save(request), /research_human_required/u);
    const saved = await f.save(request), before = f.changes();
    await assert.rejects(f.save(request, 91), /research_consistency_request_conflict/u);
    await assert.rejects(f.save({...request, requestId: 'missing-parent'}), /research_consistency_version_conflict/u);
    await assert.rejects(f.save(f.request({requestId: 'wrong-parent', parent: {reviewId: saved.snapshot.id, reviewHash: '0'.repeat(64)}})), /research_consistency_version_conflict/u);
    await assert.rejects(f.save({...request, requestId: 'stale', parent: {reviewId: saved.snapshot.id, reviewHash: saved.snapshotHash}}), /research_consistency_artifact_changed/u);
    const other = f.repository.createProject({title: 'Other scope', description: 'Isolated', workspacePath: '/tmp/roc-other'});
    const afterProject = f.changes();
    await assert.rejects(f.save({...request, projectId: other.id}), /research_consistency_project_mismatch/u);
    assert.equal(f.changes(), afterProject);
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
    await assert.rejects(f.save(f.request({requestId: 'approved'})), /research_artifact_immutable/u);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(f.save(request), /research_project_archived/u);
    assert.deepEqual(f.history().items, [saved]);
    assert.ok(before > 0);
  } finally {f.close();}
});
test('changed claims are stale while original history survives source invalidation and rehashed damage is refused', async () => {
  const f = scene();
  try {
    const saved = await f.save();
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
      content: 'Changed mean -2.35 ms.', status: 'supported', evidenceIds: [f.evidence.id]});
    const inspected = await f.inspect();
    assert.equal(inspected.report.locations[0].current, false);
    assert.equal(inspected.report.counts.changed, 1);
    f.repository.manuscripts.saveManuscript({artifactId: f.artifactId, sections: [{title: 'Results', claimIds: [f.claim.id]}]});
    assert.throws(() => f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'complete'}),
      /research_consistency_claim_changed/u);
    assert.throws(() => api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]),
      /research_consistency_claim_changed/u);
    f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
    assert.deepEqual(f.history().items, [saved]);
    assert.equal(f.repository.evidence.inspectEvidence(f.evidence.id, f.project.id).referenceStatus, 'superseded');
    await assert.rejects(f.inspect(), /research_consistency_source_changed/u);
    const damaged = structuredClone(saved.snapshot); damaged.material[0].calculation.consistent = false;
    f.db.prepare('UPDATE research_consistency_reviews SET snapshot_json=?,snapshot_hash=? WHERE id=?')
      .run(JSON.stringify(damaged), hash(damaged), saved.snapshot.id);
    assert.throws(() => f.history(), /research_consistency_snapshot_invalid/u);
  } finally {f.close();}
});

test('complete numeric history freezes independently of unrelated citation reviews and catches byte verifier conflicts', async () => {
  const f = scene();
  try {
    const first = await f.save();
    let latest = first;
    for (let version = 2; version <= 102; version++) {
      latest = api.withResearchHumanContext({capability: 'research.consistency.save', projectId: f.project.id, windowId: 90},
        () => f.repository.consistency.save(f.request({requestId: `full-history-${version}`,
          parent: {reviewId: latest.snapshot.id, reviewHash: latest.snapshotHash}}), first.snapshot.material));
    }
    const coverage = new api.ResearchCitationCoverageService(f.repository).inspect({
      projectId: f.project.id, artifactId: f.artifactId, expectedHash: null});
    const citation = api.withResearchHumanContext({capability: 'research.citationReviews.save', projectId: f.project.id, windowId: 90},
      () => f.repository.citationReviews.save({projectId: f.project.id, artifactId: f.artifactId, claimId: f.claim.id,
        evidenceId: f.evidence.id, expectedReportHash: coverage.reportHash, requestId: 'separate-directness', parent: null,
        directness: 'indirect', rationale: 'Separate synthetic inference assessment'}));
    const exported = api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]);
    assert.deepEqual(exported.consistencyReviews[0].current, latest);
    assert.deepEqual(exported.consistencyReviews[0].history.items.map(item => item.snapshot.version),
      Array.from({length: 102}, (_, i) => 102 - i));
    assert.deepEqual(exported.citationReviews[0].current, [citation]);
    const verifier = new api.ResearchArtifactScientificReviewService(f.repository,
      {evidence: async () => ({receipt: {...f.result, snapshotHash: '0'.repeat(64)}, metricId: 'mean'})},
      {verify: async () => assert.fail('manuscript has no figure review')});
    await assert.rejects(verifier.verifyArtifacts(f.project.id, [f.artifactId]), /research_consistency_source_changed/u);
    const original = f.repository.consistency.history.bind(f.repository.consistency);
    f.repository.consistency.history = request => request.offset === 0 ? original(request) :
      {verification: 'stored_receipt', items: [], total: 102};
    assert.throws(() => api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]),
      /research_export_review_history_changed/u);
  } finally {f.close();}
});
test('actual IPC sender binding and exact source conflict classification remain explicit', async () => {
  const f = scene();
  try {
    const handlers = new Map();
    api.registerResearchConsistencyCapabilities({pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {
      handlers.set(descriptor.name, handler);
    }}}, f.service, f.repository.consistency);
    const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
    const request = f.request();
    assert.equal((await bridge.invoke('research.saveConsistencyReview', [request])).error.code, 'research_sender_required');
    const saved = await bridge.invoke('research.saveConsistencyReview', [request], 90);
    assert.equal(saved.ok, true); assert.deepEqual(saved.data.snapshot.actor, {kind: 'user', id: 'window:90'});
    const invalid = f.request({requestId: 'wrong-unit', bindings: [{...request.bindings[0], unit: 's'}]});
    const reply = await bridge.invoke('research.saveConsistencyReview', [invalid], 90);
    assert.equal(reply.error.code, 'research_consistency_unit_mismatch');
    assert.equal(reply.error.category, 'validation');
  } finally {f.close();}
});
test('direct storage cannot map a claim omitted from the saved manuscript', async () => {
  const f = scene();
  try {
    const saved = await f.save();
    const omitted = f.repository.evidence.createClaim({projectId: f.project.id, artifactId: f.artifactId,
      subjectType: 'paragraph', content: f.claim.content, status: 'supported', evidenceIds: [f.evidence.id]});
    const request = f.request({requestId: 'storage-omitted',
      parent: {reviewId: saved.snapshot.id, reviewHash: saved.snapshotHash},
      bindings: [{...saved.snapshot.request.bindings[0], claimId: omitted.id,
        expectedClaimHash: api.relationClaimHash(omitted)}]});
    const material = [{...saved.snapshot.material[0], claim: omitted}], before = f.changes();
    assert.throws(() => api.withResearchHumanContext({capability: 'research.consistency.save',
      projectId: f.project.id, windowId: 90}, () => f.repository.consistency.save(request, material)),
    /research_consistency_claim_required/u);
    assert.equal(f.changes(), before);
    assert.deepEqual(f.history().items, [saved]);
  } finally {f.close();}
});
test('DB47 to current schema preserves complete prior migration receipts and installs empty consistency timelines', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(m => m.version <= 47)});
    const prior = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    applyOfflineResearchSchema(api, db);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=47 ORDER BY version').all(), prior);
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), api.researchMigrations.at(-1).version);
    assert.equal(db.prepare('SELECT count(*) FROM research_consistency_reviews').pluck().get(), 0);
    assert.equal(db.prepare('SELECT count(*) FROM research_figure_consistency_reviews').pluck().get(), 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {db.close();}
});
