import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createPublishedFigureFixture} from './fixtures/research-production-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rule = () => ({conversion: {kind: 'identity'}, rounding: {kind: 'none'},
  tolerance: {absolute: 0, relative: 0, rationale: 'Exact synthetic engineering measurement'}});
async function scene() {
  const f = await createPublishedFigureFixture(api);
  try {
    f.openRevision = () => f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'figure', action: 'reject',
      expectedArtifactVersions: f.repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'figure').artifactIds.map(artifactId => ({
        artifactId, version: f.repository.inspectArtifact({projectId: f.project.id, artifactId, expectedVersion: null}).snapshot.version
      }))});
    f.openRevision();
    const run = f.repository.experiments.create({projectId: f.project.id, ownerRunId: null, requestId: 'measurement',
      label: 'Synthetic stored measurement; not executed', engine: 'typescript', sourceVersion: 1, sourcePath: 'analysis.mts',
      inputPaths: [], parameters: {}, runtime: {kind: 'bundled-node'}, timeoutMs: 1000, network: 'disabled'},
    f.project.workspacePath, f.project.workspacePath, '/tmp/roc-synthetic-results');
    const unavailable = {kind: 'unavailable', reason: 'Synthetic contract fixture'};
    const snapshot = {schemaVersion: 1, id: 'figure-result', request: {
      projectId: f.project.id, requestId: 'reviewed-result', runId: run.id, expectedInputHash: 'a'.repeat(64),
      resultPath: 'metrics.json', expectedResultHash: 'b'.repeat(64),
      definitions: [{id: 'mean', label: 'Mean', definition: 'Synthetic mean', unit: 'ms', direction: 'lower'}],
      method: {name: 'Mean', rationale: 'Synthetic sample', assumptions: 'Synthetic', limitations: 'No scientific inference'}},
    actor: {kind: 'user', id: 'window:90'}, recordedAt: '2026-11-03T00:00:00.000Z',
    result: {schemaVersion: 1, metrics: [{id: 'mean', value: 2, unit: 'ms', sampleSize: 3,
      uncertainty: unavailable, confidenceInterval: unavailable, effect: unavailable}]},
    execution: {runId: run.id, inputHash: 'a'.repeat(64), engine: 'typescript', environmentHash: 'c'.repeat(64),
      source: {area: 'input', path: 'analysis.mts', sha256: 'd'.repeat(64), size: 5},
      output: {area: 'output', path: 'metrics.json', sha256: 'b'.repeat(64), size: 10}, inputs: [],
      parameters: {}, arguments: [], seed: null}};
    f.result = f.repository.experimentResults.save({snapshot, snapshotHash: hash(snapshot)});
    f.evidence = f.repository.experimentResults.captureMetric(f.result, 'mean');
    const claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
    f.claim = f.repository.evidence.updateClaim({id: claim.id, expectedVersion: claim.version,
      content: 'Synthetic figure maps an actual post-transform bar datum to a stored metric.',
      status: 'supported', evidenceIds: [f.evidence.id]});
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'figure', action: 'complete'});
    f.tracePath = join(f.repository.figureRuns.root(f.project.id, f.productionRun.id), 'output', 'figure-data.json');
    f.trace = JSON.parse(await readFile(f.tracePath, 'utf8'));
    f.mark = f.trace.marks.find(mark => mark.directFields.y === 'mean_end');
    assert.ok(f.mark, 'compiled stack endpoint is the actual y datum');
    f.binding = (item = f.mark.items[0]) => ({claimId: f.claim.id, expectedClaimHash: api.relationClaimHash(f.claim),
      markName: f.mark.name, channel: 'y', field: 'mean_end', scenePath: item.scenePath, unit: 'ms',
      evidenceId: f.evidence.id, resultId: f.result.snapshot.id, resultHash: f.result.snapshotHash, metricId: 'mean', rule: rule()});
    f.service = new api.ResearchFigureConsistencyService(f.repository, f.figureService,
      {evidence: async () => ({receipt: f.result, metricId: 'mean'})});
    f.inspect = (page = {markName: null, offset: 0, limit: 100}, expectedHash = null) =>
      f.service.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash, page});
    f.request = (overrides = {}) => ({projectId: f.project.id, artifactId: f.artifactId, requestId: 'mapping',
      expectedArtifactVersion: f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null}).snapshot.version,
      figure: {id: f.figureId, manifestHash: f.repository.figures.get(f.project.id, f.figureId).manifestHash, traceHash: hash(f.trace)},
      parent: null, rationale: 'Explicit mapping of compiled bar endpoint', bindings: [f.binding()], ...overrides});
    f.save = (request = f.request(), windowId = 90) => api.withResearchHumanContext({
      capability: 'research.figureConsistency.save', projectId: request.projectId, windowId}, () => f.service.save(request));
    f.history = (offset = 0, limit = 10) => f.repository.figureConsistency.history({
      projectId: f.project.id, artifactId: f.artifactId, offset, limit});
    f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
    return f;
  } catch (error) {await f.dispose(); throw error;}
}
test('actual compiled scene mapping is immutable, replay writes zero and invalidates whole-artifact gate version', async () => {
  const f = await scene();
  try {
    const initial = await f.inspect(), request = f.request(), saved = await f.save(request);
    assert.equal(saved.snapshot.material.mappings[0].item.numericFields.mean_end, 2);
    assert.equal(saved.snapshot.material.mappings[0].calculation.consistent, true);
    const before = f.changes();
    assert.deepEqual(await f.save(request), saved); assert.equal(f.changes(), before);
    const current = await f.inspect(undefined, initial.reportHash);
    assert.equal(current.status, 'stale'); assert.equal(current.report.counts.consistent, 1);
    assert.equal(current.report.counts.inconsistent, 0);
    assert.equal(current.report.counts.unmapped, current.report.counts.numericLocations - 1);
    assert.notEqual(current.report.artifactVersion, request.expectedArtifactVersion);
    assert.throws(() => f.repository.assertArtifactReview({projectId: f.project.id, expectedStage: 'figure',
      expectedArtifactVersions: [{artifactId: f.artifactId, version: request.expectedArtifactVersion}]}),
    /research_artifact_review_changed/u);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
    const second = await f.save(f.request({requestId: 'second', parent: {reviewId: saved.snapshot.id, reviewHash: saved.snapshotHash},
      bindings: [f.binding(f.mark.items[1])]}));
    assert.equal(second.snapshot.material.mappings[0].calculation.consistent, false);
    assert.equal((await f.inspect()).report.counts.inconsistent, 1);
    assert.deepEqual(f.history(0, 1).items, [second]); assert.deepEqual(f.history(1, 1).items, [saved]);
    assert.equal(f.history().verification, 'stored_receipt');
  } finally {await f.dispose();}
});
test('explicit pagination returns exact scene paths and unknown marks or partial field encodings reject', async () => {
  const f = await scene();
  try {
    const summary = await f.inspect();
    assert.deepEqual(summary.report.items, []); assert.equal(summary.report.total, 0);
    const first = await f.inspect({markName: f.mark.name, offset: 0, limit: 1});
    const second = await f.inspect({markName: f.mark.name, offset: 1, limit: 1});
    assert.deepEqual(first.report.items, [f.mark.items[0]]); assert.deepEqual(second.report.items, [f.mark.items[1]]);
    assert.equal(first.report.total, f.mark.items.length);
    await assert.rejects(f.inspect({markName: 'unknown', offset: 0, limit: 1}), /research_figure_consistency_mark_not_found/u);
    const before = f.changes();
    for (const binding of [{...f.binding(), field: 'mean'}, {...f.binding(), channel: 'width'},
      {...f.binding(), scenePath: [999999]}]) {
      await assert.rejects(f.save(f.request({bindings: [binding]})),
        /research_figure_consistency_(encoding_unsupported|value_required)/u);
    }
    assert.equal(f.changes(), before);
  } finally {await f.dispose();}
});
test('strict contracts, sender identity, latest parent, artifact version and immutable states reject', async () => {
  const f = await scene();
  try {
    const request = f.request();
    for (const value of [{...request, actor: {kind: 'user', id: 'forged'}}, {...request, bindings: []},
      {...request, bindings: [request.bindings[0], request.bindings[0]]}, {...request, expectedArtifactVersion: null},
      {...request, bindings: [{...request.bindings[0], rule: {...rule(), tolerance: {absolute: -1, relative: 0, rationale: 'invalid'}}}]}]) {
      assert.equal(api.researchFigureConsistencySaveSchema.safeParse(value).success, false);
    }
    await assert.rejects(f.service.save(request), /research_human_required/u);
    const saved = await f.save(request), before = f.changes();
    await assert.rejects(f.save(request, 91), /research_figure_consistency_request_conflict/u);
    await assert.rejects(f.save({...request, rationale: 'Changed replay'}), /research_figure_consistency_request_conflict/u);
    await assert.rejects(f.save(f.request({requestId: 'missing-parent'})), /research_figure_consistency_version_conflict/u);
    await assert.rejects(f.save({...request, requestId: 'stale', parent: {reviewId: saved.snapshot.id, reviewHash: saved.snapshotHash}}),
      /research_consistency_artifact_changed/u);
    assert.equal(f.changes(), before);
    const other = f.repository.createProject({title: 'Other', description: 'Isolated scope', workspacePath: '/tmp/roc-other'});
    await assert.rejects(f.save({...request, projectId: other.id}), /research_figure_consistency_project_mismatch/u);
    const next = f.request({requestId: 'invalid-material', parent: {reviewId: saved.snapshot.id, reviewHash: saved.snapshotHash}});
    assert.throws(() => api.withResearchHumanContext({capability: 'research.figureConsistency.save', projectId: f.project.id, windowId: 90},
      () => f.repository.figureConsistency.save(next, {...saved.snapshot.material, mappings: []}, f.trace)),
    error => error.name === 'ZodError' && error.issues[0].path[0] === 'mappings');
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
    await assert.rejects(f.save(next), /research_artifact_immutable/u);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(f.save(request), /research_project_archived/u);
    assert.deepEqual(f.history().items, [saved]);
  } finally {await f.dispose();}
});
test('claim drift is visible while stored history survives invalidated evidence and rejects rehashed damage', async () => {
  const f = await scene();
  try {
    const saved = await f.save();
    f.openRevision();
    f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
      content: 'Revised scientific meaning requires new mapping.', status: 'supported', evidenceIds: [f.evidence.id]});
    assert.throws(() => f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'figure', action: 'complete'}),
      /research_consistency_claim_changed/u);
    const changed = await f.inspect(); assert.equal(changed.report.counts.changed, 1);
    assert.equal(changed.report.locations[0].current, false);
    f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
    await assert.rejects(f.inspect(), /research_consistency_source_changed/u);
    assert.deepEqual(f.history().items, [saved]);
    for (const change of [
      value => {value.material.mappings[0].calculation.consistent = false;},
      value => {value.material.trace.sourceHash = '0'.repeat(64);}
    ]) {
      const damaged = structuredClone(saved.snapshot); change(damaged);
      f.db.prepare('UPDATE research_figure_consistency_reviews SET snapshot_json=?,snapshot_hash=? WHERE id=?')
        .run(JSON.stringify(damaged), hash(damaged), saved.snapshot.id);
      assert.throws(() => f.history(), /research_figure_consistency_snapshot_invalid/u);
    }
  } finally {await f.dispose();}
});
test('actual trace change during metric await rejects with zero saved reviews and history stays readable', async () => {
  const f = await scene();
  try {
    const saved = await f.save(), bytes = await readFile(f.tracePath);
    f.service = new api.ResearchFigureConsistencyService(f.repository, f.figureService, {evidence: async () => {
      await writeFile(f.tracePath, Buffer.concat([bytes, Buffer.from(' ')]));
      return {receipt: f.result, metricId: 'mean'};
    }});
    const before = f.changes();
    await assert.rejects(f.save(f.request({requestId: 'changed-file', parent: {reviewId: saved.snapshot.id, reviewHash: saved.snapshotHash}})),
      /research_figure_snapshot_changed/u);
    assert.equal(f.changes(), before); assert.deepEqual(f.history().items, [saved]);
    await assert.rejects(f.inspect(), /research_figure_snapshot_changed/u);
  } finally {await f.dispose();}
});
test('evidence changes across awaits reject before any review is inserted', async () => {
  const f = await scene();
  try {
    f.service = new api.ResearchFigureConsistencyService(f.repository, f.figureService, {evidence: async () => {
      f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
      return {receipt: f.result, metricId: 'mean'};
    }});
    await assert.rejects(f.save(), /research_evidence_reference_superseded/u);
    assert.equal(f.history().total, 0);
  } finally {await f.dispose();}
});
test('inspection refuses a whole-artifact change during the asynchronous result read', async () => {
  const f = await scene();
  try {
    const saved = await f.save();
    f.service = new api.ResearchFigureConsistencyService(f.repository, f.figureService, {evidence: async () => {
      f.openRevision();
      f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
        content: 'Changed during result read.', status: 'supported', evidenceIds: [f.evidence.id]});
      return {receipt: f.result, metricId: 'mean'};
    }});
    await assert.rejects(f.inspect(), /research_consistency_artifact_changed/u);
    assert.deepEqual(f.history().items, [saved]);
  } finally {await f.dispose();}
});
test('public IPC binds window actor and classifies explicit field/unit conflicts', async () => {
  const f = await scene();
  try {
    const handlers = new Map();
    api.registerResearchFigureConsistencyCapabilities({pluginId: 'fixture', capabilities: {
      register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}
    }}, f.service, f.repository.figureConsistency);
    const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
    assert.equal((await bridge.invoke('research.saveFigureConsistencyReview', [f.request()])).error.code, 'research_sender_required');
    const saved = await bridge.invoke('research.saveFigureConsistencyReview', [f.request()], 90);
    assert.equal(saved.ok, true); assert.deepEqual(saved.data.snapshot.actor, {kind: 'user', id: 'window:90'});
    const reply = await bridge.invoke('research.saveFigureConsistencyReview', [f.request({
      requestId: 'wrong-unit', bindings: [{...f.binding(), unit: 's'}]})], 90);
    assert.equal(reply.error.code, 'research_consistency_unit_mismatch'); assert.equal(reply.error.category, 'validation');
    const history = await bridge.invoke('research.getFigureConsistencyHistory', [{
      projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 1}]);
    assert.deepEqual(history.data.items, [saved.data]);
  } finally {await f.dispose();}
});

test('export freezes 102 complete plotted revisions with explicit redaction and retained inconsistent findings', async () => {
  const f = await scene();
  try {
    const first = await f.save();
    const second = await f.save(f.request({requestId: 'history-2',
      parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}, bindings: [f.binding(f.mark.items[1])]}));
    let latest = second;
    for (let version = 3; version <= 102; version++) {
      latest = api.withResearchHumanContext({capability: 'research.figureConsistency.save', projectId: f.project.id, windowId: 90},
        () => f.repository.figureConsistency.save(f.request({requestId: `history-${version}`,
          parent: {reviewId: latest.snapshot.id, reviewHash: latest.snapshotHash},
          bindings: [f.binding(f.mark.items[1])]}), second.snapshot.material, f.trace));
    }
    const before = f.changes();
    const review = api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]);
    assert.equal(f.changes(), before);
    const exported = review.figureConsistencyReviews[0];
    assert.equal(exported.history.total, 102);
    assert.deepEqual(exported.history.items.map(item => item.snapshot.version), Array.from({length: 102}, (_, i) => 102 - i));
    assert.equal(exported.current.snapshot.material.mappings[0].calculation.consistent, false);
    assert.equal(exported.current.originalSnapshotHash, latest.snapshotHash);
    assert.equal(exported.current.redactedSnapshotHash, hash(exported.current.snapshot));
    assert.equal(exported.current.verification, 'redacted_receipt');
    assert.equal(Object.hasOwn(exported.current.snapshot.material.run, 'workspacePath'), false);
    assert.equal(Object.hasOwn(exported.current.snapshot.material.run, 'workspaceRoot'), false);
    assert.equal(api.researchExportFigureReviewSchema.safeParse({
      ...exported.current, snapshot: {...exported.current.snapshot, material: latest.snapshot.material}
    }).success, false);
    const originalBytes = JSON.stringify(first);
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
    assert.deepEqual(api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]), review);
    assert.equal(JSON.stringify(f.history(101, 1).items[0]), originalBytes);
    await writeFile(f.tracePath, 'changed current bytes');
    assert.deepEqual(f.history(101, 1).items, [first]);
    const verifier = new api.ResearchArtifactScientificReviewService(f.repository,
      {evidence: async () => ({receipt: f.result, metricId: 'mean'})}, f.figureService);
    await assert.rejects(verifier.verifyArtifacts(f.project.id, [f.artifactId]), /research_figure_snapshot_changed/u);
  } finally {await f.dispose();}
});

test('gate refuses missing byte verifier and changed receipt during result await before approval', async () => {
  const f = await scene();
  try {
    const first = await f.save();
    const request = {projectId: f.project.id, expectedStage: 'figure', action: 'approve',
      expectedArtifactVersions: [{artifactId: f.artifactId, version: f.request().expectedArtifactVersion}]};
    await assert.rejects(api.createResearchHumanGate({repository: f.repository, production: f.figureService}).approve(request),
      /research_scientific_review_verify_unavailable/u);
    let next;
    const scientificReviews = new api.ResearchArtifactScientificReviewService(f.repository, {evidence: async () => {
      next = api.withResearchHumanContext({capability: 'research.figureConsistency.save', projectId: f.project.id, windowId: 90},
        () => f.repository.figureConsistency.save(f.request({requestId: 'during-await',
          parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}}), first.snapshot.material, f.trace));
      return {receipt: f.result, metricId: 'mean'};
    }}, f.figureService);
    await assert.rejects(api.createResearchHumanGate({repository: f.repository, production: f.figureService, scientificReviews}).approve(request),
      /research_artifact_review_changed/u);
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
    assert.equal(f.repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'figure').gateApproved, false);
    assert.deepEqual(f.history().items, [next, first]);
  } finally {await f.dispose();}
});
