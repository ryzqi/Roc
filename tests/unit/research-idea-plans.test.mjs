import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {ideaCanvasContentFixture, ideaPlanBodyFixture} from './fixtures/research-idea-plan.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const digest = value => createHash('sha256').update(value).digest('hex');

function scene() {
  const f = createResearchFixture(api, 'ideation');
  const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'ideation', kind: 'idea_canvas',
    title: 'Synthetic testable hypothesis', path: null});
  const canvas = f.repository.ideas.save({artifactId: artifact.id, expectedVersion: null, ...ideaCanvasContentFixture()});
  const handlers = new Map();
  api.registerResearchIdeaPlanCapabilities({
    pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}
  }, f.repository.ideaPlans);
  const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, request) => handlers.get(name)(request)});
  const request = {projectId: f.project.id, artifactId: artifact.id, requestId: 'plan-first',
    canvas: {version: canvas.version, contentHash: canvas.contentHash}, parent: null, revisionReason: null, body: ideaPlanBodyFixture()};
  const human = (capability, action, windowId = 72) =>
    api.withResearchHumanContext({capability, projectId: f.project.id, windowId}, action);
  const save = input => human('research.ideaPlans.save', () => f.repository.ideaPlans.save(input));
  const reference = value => ({projectId: f.project.id, artifactId: artifact.id, versionId: value.version.id, expectedHash: value.versionHash});
  const freeze = (value, overrides = {}) => human('research.ideaPlans.freeze', () => f.repository.ideaPlans.freeze({
    ...reference(value), requestId: `freeze-${value.version.version}`, reviewNote: 'Human checked the frozen method and predictions.', ...overrides
  }));
  return {...f, artifact, canvas, request, handlers, bridge, human, save, reference, freeze};
}

test('method plan schemas require falsifiable predictions, declared metrics, observation timing and reviewed power inputs', () => {
  const body = ideaPlanBodyFixture();
  assert.deepEqual(api.researchIdeaPlanBodySchema.parse(body), body);
  for (const invalid of [
    {...body, falsifiableIf: ''}, {...body, metrics: []}, {...body, metrics: [body.metrics[0], body.metrics[0]]},
    {...body, observation: {kind: 'after_data', evidenceIds: []}},
    {...body, novelty: {...body.novelty, status: 'proven'}},
    {...body, sampleSize: {kind: 'not_calculated'}},
    {...body, sampleSize: {kind: 'calculated', method: 'Power calculation', parameters: {}, value: 10, evidenceIds: [], reviewNote: 'Reviewed'}},
    {...body, winner: true}
  ]) assert.equal(api.researchIdeaPlanBodySchema.safeParse(invalid).success, false);
  const f = scene();
  try {
    assert.equal(api.researchIdeaPlanSaveSchema.safeParse({...f.request, parent: {versionId: 'parent', versionHash: 'a'.repeat(64)}}).success, false);
    assert.equal(api.researchIdeaPlanSaveSchema.safeParse({...f.request, revisionReason: 'No parent'}).success, false);
  } finally {f.close();}
});

test('actual human IPC freezes exact Canvas and method hashes; reply loss replays without writes or model authority', async () => {
  const f = scene();
  try {
    const missingSender = await f.bridge.invoke('research.saveIdeaPlan', [f.request]);
    assert.equal(missingSender.ok, false); assert.equal(missingSender.error.code, 'research_sender_required');
    await assert.rejects(() => f.handlers.get('research.ideaPlans.save')(f.request),
      {code: 'research_human_required', category: 'permission'});
    const saved = await f.bridge.invoke('research.saveIdeaPlan', [f.request], 72);
    assert.equal(saved.ok, true);
    const first = saved.data;
    assert.equal(first.version.actor.id, 'window:72');
    assert.equal(first.versionHash, digest(JSON.stringify(first.version)));
    assert.equal(first.freeze, null);
    const changes = f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(await f.bridge.invoke('research.saveIdeaPlan', [f.request], 72), saved);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
    const wrongActor = await f.bridge.invoke('research.saveIdeaPlan', [f.request], 73);
    assert.equal(wrongActor.ok, false); assert.equal(wrongActor.error.code, 'research_idea_plan_request_conflict');
    const freezeRequest = {...f.reference(first), requestId: 'human-freeze', reviewNote: 'Checked every metric and limitation'};
    const frozen = await f.bridge.invoke('research.freezeIdeaPlan', [freezeRequest], 72);
    assert.equal(frozen.ok, true); assert.equal(frozen.data.freeze.actor.id, 'window:72');
    assert.equal(frozen.data.freezeHash, digest(JSON.stringify(frozen.data.freeze)));
    const afterFreeze = f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(await f.bridge.invoke('research.freezeIdeaPlan', [freezeRequest], 72), frozen);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), afterFreeze);
    assert.throws(() => f.freeze(first), /research_idea_plan_already_frozen/u);
    const invalid = await f.bridge.invoke('research.getIdeaPlan', [{...f.reference(first), expectedHash: 'f'.repeat(64)}], 72);
    assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'research_idea_plan_version_conflict');
  } finally {f.close();}
});

test('revisions preserve frozen expectations, exact negative evidence and power method, and cannot rewrite observation history', () => {
  const f = scene();
  try {
    const first = f.save(f.request), frozen = f.freeze(first);
    f.repository.knowledge.upsertFromSource({id: 'observed-negative', projectId: f.project.id, sourceType: 'experiment',
      sourceId: 'synthetic-negative-result', title: 'Synthetic negative observation', content: 'Observed difference: -2 ms',
      chunks: [{content: 'Observed difference: -2 ms', locator: 'metrics.json:/metrics/0'}], embeddingPolicy: 'none'});
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'observed-negative:chunk:0'});
    const request = {...f.request, requestId: 'after-observation',
      parent: {versionId: first.version.id, versionHash: first.versionHash}, revisionReason: 'Revise analysis after inspecting the actual negative observation',
      body: {...f.request.body, observation: {kind: 'after_data', evidenceIds: [evidence.id]},
        analysisPlan: 'Preserve the observed negative result and document the revised model.',
        novelty: {...f.request.body.novelty, comparisons: [{evidenceId: evidence.id, similarities: 'Same synthetic metric', differences: 'Different declared parameters'}]},
        sampleSize: {kind: 'calculated', method: 'Explicit synthetic power formula', parameters: {alpha: '0.05', power: '0.8'},
          value: 20, evidenceIds: [evidence.id], reviewNote: 'Human reviewed synthetic calculation assumptions'}}};
    const second = f.save(request);
    assert.equal(second.version.version, 2);
    assert.deepEqual(second.version.request.body.sampleSize, request.body.sampleSize);
    assert.deepEqual(f.repository.ideaPlans.get(f.reference(first)).version, frozen.version);
    assert.deepEqual(f.repository.ideaPlans.get(f.reference(first)).freeze, frozen.freeze);
    const history = f.repository.ideaPlans.history({projectId: f.project.id, artifactId: f.artifact.id, offset: 0, limit: 1});
    assert.equal(history.total, 2); assert.deepEqual(history.items, [second]);
    assert.equal(f.repository.ideaPlans.history({projectId: f.project.id, artifactId: f.artifact.id, offset: 1, limit: 1}).items[0].version.id, first.version.id);
    assert.throws(() => f.save({...request, requestId: 'revert-observation',
      parent: {versionId: second.version.id, versionHash: second.versionHash}, body: f.request.body}),
    /research_idea_plan_observation_conflict/u);
    assert.throws(() => f.freeze(first, {requestId: 'freeze-old-again'}), /research_idea_plan_version_conflict/u);
    assert.equal(f.freeze(second).freeze.request.versionId, second.version.id);
    assert.equal(f.repository.evidence.getEvidence(evidence.id, f.project.id).excerpt, 'Observed difference: -2 ms');
  } finally {f.close();}
});

test('foreign project, missing or stale evidence, changed Canvas and archived writes fail without orphan revisions', () => {
  const f = scene();
  try {
    const other = f.repository.createProject({title: 'Foreign plan project', description: 'Isolation', workspacePath: '/tmp/foreign-method-plan'});
    assert.throws(() => f.human('research.ideaPlans.save', () => f.repository.ideaPlans.save({...f.request, projectId: other.id})), /research_human_project_mismatch/u);
    assert.throws(() => api.withResearchHumanContext({capability: 'research.ideaPlans.save', projectId: other.id, windowId: 72},
      () => f.repository.ideaPlans.save({...f.request, projectId: other.id})), /research_idea_plan_project_mismatch/u);
    assert.throws(() => f.save({...f.request, canvas: {...f.request.canvas, contentHash: 'f'.repeat(64)}}), /research_idea_plan_canvas_changed/u);
    assert.throws(() => f.save({...f.request, body: {...f.request.body, hypothesis: 'Invented new proposition'}}), /research_idea_plan_hypothesis_mismatch/u);
    assert.throws(() => f.save({...f.request, body: {...f.request.body, observation: {kind: 'after_data', evidenceIds: ['missing']}}}), /research_evidence_not_found/u);
    f.repository.knowledge.upsertFromSource({id: 'plan-stale-source', projectId: f.project.id, sourceType: 'file',
      sourceId: 'synthetic-observation.txt', title: 'Original observation', content: 'Original synthetic observation',
      chunks: [{content: 'Original synthetic observation', locator: 'block:0'}], embeddingPolicy: 'none'});
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'plan-stale-source:chunk:0'});
    const observed = {...f.request, body: {...f.request.body, observation: {kind: 'after_data', evidenceIds: [evidence.id]}}};
    f.repository.evidence.invalidateEvidence(evidence.id, f.project.id);
    assert.throws(() => f.save(observed), /research_evidence_reference_superseded/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_idea_plan_versions').pluck().get(), 0);
    const first = f.save(f.request);
    assert.throws(() => f.repository.ideaPlans.get({...f.reference(first), projectId: other.id}), /research_idea_plan_project_mismatch/u);
    const updated = f.repository.ideas.save({artifactId: f.artifact.id, expectedVersion: 1, ...ideaCanvasContentFixture(), experiment: 'A revised design',
      fields: ideaCanvasContentFixture().fields.map(field => field.key === 'experiment' ? {...field, content: 'A revised design'} : field)});
    assert.equal(updated.version, 2);
    assert.equal(f.repository.ideaPlans.get(f.reference(first)).canvasCurrent, false);
    assert.throws(() => f.freeze(first), /research_idea_plan_canvas_changed/u);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.throws(() => f.save(f.request), /research_project_archived/u);
    assert.throws(() => f.freeze(first), /research_project_archived/u);
    assert.equal(f.repository.ideaPlans.get(f.reference(first)).version.id, first.version.id);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_idea_plan_freezes').pluck().get(), 0);
  } finally {f.close();}
});

test('corrupt or deleted frozen receipts and rehashed request metadata cannot masquerade as valid plans', () => {
  const f = scene();
  try {
    const first = f.freeze(f.save(f.request));
    const row = f.db.prepare('SELECT * FROM research_idea_plan_freezes').get();
    f.db.prepare('DELETE FROM research_idea_plan_freezes').run();
    assert.throws(() => f.repository.ideaPlans.get(f.reference(first)), /research_idea_plan_snapshot_invalid/u);
    f.db.prepare(`INSERT INTO research_idea_plan_freezes (version_id,project_id,request_id,snapshot_json,snapshot_hash,created_at)
      VALUES (@version_id,@project_id,@request_id,@snapshot_json,@snapshot_hash,@created_at)`).run(row);
    const corrupted = structuredClone(first.version);
    corrupted.request.body.falsifiableIf = 'A tampered condition';
    const json = JSON.stringify(corrupted);
    f.db.prepare('UPDATE research_idea_plan_versions SET snapshot_json=?,snapshot_hash=? WHERE id=?').run(json, digest(json), first.version.id);
    assert.throws(() => f.repository.ideaPlans.get({...f.reference(first), expectedHash: digest(json)}), /research_idea_plan_snapshot_invalid/u);
  } finally {f.close();}
});

test('disk restart reads exact frozen plans without any writes, and DB44 upgrade preserves original Canvas bytes', async () => {
  const f = scene(), root = mkdtempSync(join(tmpdir(), 'roc-method-plan-'));
  let disk;
  try {
    const first = f.freeze(f.save(f.request)), path = join(root, 'research.sqlite');
    await f.db.backup(path); disk = new Database(path); disk.pragma('foreign_keys=ON');
    api.applyResearchDatabaseSchema(disk);
    const repository = new api.ResearchRepository(disk, f.tasks);
    const changes = disk.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(repository.ideaPlans.get(f.reference(first)), first);
    assert.equal(disk.prepare('SELECT total_changes()').pluck().get(), changes);
    assert.deepEqual(disk.pragma('foreign_key_check'), []);
    const old = new Database(':memory:'); old.pragma('foreign_keys=ON');
    try {
      api.applyDatabaseMigrations(old, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(entry => entry.version <= 44)});
      for (const table of ['research_projects', 'research_artifacts', 'research_idea_canvases', 'research_idea_canvas_revisions']) {
        for (const row of f.db.prepare(`SELECT * FROM ${table}`).all()) {
          const columns = Object.keys(row);
          old.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
        }
      }
      const original = old.prepare('SELECT * FROM research_idea_canvases').get(), originalRevision = old.prepare('SELECT * FROM research_idea_canvas_revisions').get();
      api.applyResearchDatabaseSchema(old);
      assert.equal(old.prepare('SELECT current_version FROM schema_metadata').pluck().get(), api.researchMigrations.at(-1).version);
      assert.deepEqual(old.prepare('SELECT * FROM research_idea_canvases').get(), original);
      assert.deepEqual(old.prepare('SELECT * FROM research_idea_canvas_revisions').get(), originalRevision);
      assert.equal(old.prepare('SELECT count(*) FROM research_idea_plan_versions').pluck().get(), 0);
      assert.deepEqual(old.pragma('foreign_key_check'), []);
    } finally {old.close();}
  } finally {disk?.close(); f.close(); rmSync(root, {recursive: true, force: true});}
});
