import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import Database from 'better-sqlite3';
import {withResearchTestWorker, loadResearchTestApi, createResearchFixture} from './fixtures/research-test-kit.mjs';
import {ideaCanvasContentFixture, ideaPlanBodyFixture} from './fixtures/research-idea-plan.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = 'a'.repeat(64);
function request() {
  return {projectId: 'project', artifactId: 'canvas', requestId: 'assessment',
    plan: {versionId: 'plan', versionHash: hash, freezeHash: hash}, result: {resultId: 'result', expectedHash: hash},
    metrics: [{kind: 'measured', plannedMetricId: 'mean', evidenceId: 'evidence'}],
    verdict: 'contradicts', reviewNote: 'The actual outcome contradicts the frozen prediction.',
    parent: null, revisionReason: null};
}
test('outcome requests require explicit reviewed mappings and revisions without model or sender authority fields', () => {
  assert.deepEqual(api.researchIdeaOutcomeSaveSchema.parse(request()), request());
  for (const value of [
    {...request(), actor: {kind: 'user', id: 'forged'}}, {...request(), metrics: []},
    {...request(), metrics: [{kind: 'missing', plannedMetricId: 'mean', reason: 'No measurement'}]},
    {...request(), metrics: [request().metrics[0], request().metrics[0]]},
    {...request(), metrics: [request().metrics[0], {...request().metrics[0], plannedMetricId: 'other'}]},
    {...request(), verdict: 'significant'}, {...request(), reviewNote: ''},
    {...request(), parent: {outcomeId: 'prior', outcomeHash: hash}},
    {...request(), plan: {versionId: 'plan', versionHash: hash}},
    {...request(), revisionReason: 'Not a revision'}
  ]) assert.equal(api.researchIdeaOutcomeSaveSchema.safeParse(value).success, false);
});

test('actual plan/result evidence comparison reports precise definition unit direction and missing metric dimensions without inferring support', async () => {
  const definition = ideaPlanBodyFixture().metrics[0];
  const plan = {version: {request: {body: {metrics: [definition]}}}, versionHash: hash, freeze: {}, freezeHash: hash};
  const result = {snapshot: {id: 'result', execution: {runId: 'run'}, request: {definitions: [structuredClone(definition)]}}, snapshotHash: hash};
  const research = {ideaPlans: {get: () => plan}, experiments: {get: () => ({
    status: 'completed', startedAt: '2026-11-03T01:00:00.000Z', endedAt: '2026-11-03T01:01:00.000Z'
  })}, evidence: {getEvidence: () => ({id: 'evidence'})}, getProject: () => ({status: 'active'}),
  ideaOutcomes: {save: (_request, material) => material}};
  const service = new api.ResearchIdeaOutcomeService(research, {
    get: async () => result, evidence: async () => ({receipt: result, metricId: 'mean'})
  });
  const save = value => api.withResearchHumanContext({capability: 'research.ideaOutcomes.save', projectId: 'project', windowId: 61},
    () => service.save(value));
  assert.deepEqual((await save(request())).differences, []);
  for (const field of ['definition', 'unit', 'direction']) {
    result.snapshot.request.definitions = [{...definition, [field]: field === 'direction' ? 'higher' : 'changed'}];
    await assert.rejects(save(request()), /research_idea_outcome_comparability_conflict/u);
    assert.deepEqual((await save({...request(), verdict: 'not_comparable'})).differences, [{plannedMetricId: 'mean', fields: [field]}]);
  }
  result.snapshot.request.definitions = [definition];
  plan.version.request.body.metrics = [definition, {...definition, id: 'secondary'}];
  const partial = {...request(), verdict: 'not_comparable', metrics: [...request().metrics,
    {kind: 'missing', plannedMetricId: 'secondary', reason: 'Secondary metric was not measured'}]};
  assert.deepEqual((await save(partial)).differences, [{plannedMetricId: 'secondary', fields: ['missing_metric']}]);
  await assert.rejects(save(request()), /research_idea_outcome_metric_mapping_invalid/u);
  await assert.rejects(service.save(partial), /research_human_required/u);
});

test('DB45 to46 preserves original Canvas and frozen method bytes and adds only the empty assessment timeline', () => {
  const f = createResearchFixture(api, 'ideation'), old = new Database(':memory:');
  try {
    const run = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {
      title: 'Frozen plan migration', markdown: 'Synthetic Canvas', claims: [], sections: [], verdict: 'uncertain',
      ideaCanvas: ideaCanvasContentFixture()
    })), artifactId = run.outputArtifactIds[0], canvas = f.repository.ideas.get(artifactId);
    const plan = api.withResearchHumanContext({capability: 'research.ideaPlans.save', projectId: f.project.id, windowId: 61},
      () => f.repository.ideaPlans.save({projectId: f.project.id, artifactId, requestId: 'method',
        canvas: {version: canvas.version, contentHash: canvas.contentHash}, parent: null, revisionReason: null, body: ideaPlanBodyFixture()}));
    api.withResearchHumanContext({capability: 'research.ideaPlans.freeze', projectId: f.project.id, windowId: 61},
      () => f.repository.ideaPlans.freeze({projectId: f.project.id, artifactId, versionId: plan.version.id,
        expectedHash: plan.versionHash, requestId: 'freeze', reviewNote: 'Engineering migration fixture'}));
    old.pragma('foreign_keys=ON');
    api.applyDatabaseMigrations(old, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(entry => entry.version <= 45)});
    const tables = ['research_projects', 'research_artifacts', 'research_idea_canvases',
      'research_idea_canvas_revisions', 'research_idea_plan_versions', 'research_idea_plan_freezes'];
    const originals = new Map();
    for (const table of tables) {
      const rows = f.db.prepare(`SELECT * FROM ${table}`).all();
      originals.set(table, rows);
      for (const row of rows) {
        const columns = Object.keys(row);
        old.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
      }
    }
    api.applyDatabaseMigrations(old, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(entry => entry.version <= 46)});
    assert.equal(old.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 46);
    for (const table of tables) assert.deepEqual(old.prepare(`SELECT * FROM ${table}`).all(), originals.get(table));
    assert.equal(old.prepare('SELECT count(*) FROM research_idea_outcomes').pluck().get(), 0);
    assert.deepEqual(old.pragma('foreign_key_check'), []);
  } finally {old.close(); f.close();}
});

test('outcome IPC retains known integrity errors and hides unexpected internal failures', async () => {
  let failure = new Error('research_result_evidence_changed');
  const handlers = new Map();
  api.registerResearchIdeaOutcomeCapabilities({pluginId: 'fixture', capabilities: {
    register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}
  }}, {}, {save: async () => {throw failure;}});
  const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, value) => handlers.get(name)(value)});
  const known = await bridge.invoke('research.saveIdeaOutcome', [request()], 61);
  assert.equal(known.ok, false);
  assert.equal(known.error.code, 'research_result_evidence_changed');
  failure = new Error('research_experiment_snapshot_changed');
  const drift = await bridge.invoke('research.saveIdeaOutcome', [request()], 61);
  assert.equal(drift.ok, false);
  assert.equal(drift.error.code, 'research_experiment_snapshot_changed');
  failure = new Error('private internal failure');
  const unknown = await bridge.invoke('research.saveIdeaOutcome', [request()], 61);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'internal_error');
  assert.doesNotMatch(unknown.error.message, /private/u);
});
