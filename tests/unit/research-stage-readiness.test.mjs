import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {after, before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api, registryApi;
const bundle = JSON.parse(readFileSync('resources/research-skills/catalog.json', 'utf8'));
before(async () => {
  api = await loadResearchTestApi();
  registryApi = await importTypeScriptModule('src/main/plugins/research/skill-registry.ts', {platform: 'node'});
});
after(() => api.dispose());

function probe(stage, reply) {
  const {manifest, pin} = new registryApi.ResearchSkillRegistry(bundle).load(stage);
  const names = {'research.knowledge.search': 'search_knowledge', 'research.evidence.list': 'list_evidence',
    'research.evidence.inspect': 'inspect_evidence_source', 'research.artifacts.get': 'read_artifact'};
  const run = {id: 'stage-run', stage, projectId: 'project', toolNames: manifest.requiredCapabilities.map(capability => names[capability])};
  const calls = [];
  let verified = 0;
  const registry = {list: () => [...manifest.requiredCapabilities, 'research.figure.environment', 'research.toolchain.status'].map(name => ({name})),
    invoke: async (name, request, signal) => {calls.push({name, request}); signal.throwIfAborted(); return reply(name);}};
  const repository = {runs: {getContext: id => {assert.equal(id, run.id); return {skillPin: pin};},
    assertInputsCurrent: current => {assert.equal(current, run); verified++;}}};
  return {service: new api.ResearchStageReadinessService(repository, registry), run, registry, calls, verified: () => verified};
}

test('production readiness uses declared native probes without executing experiments or granting tools', async () => {
  const exports = probe('export', () => ({available: false, versions: null, error: 'research_toolchain_unavailable'}));
  await assert.rejects(exports.service.check(exports.run, new AbortController().signal), /research_skill_runtime_unavailable:research_toolchain_unavailable/u);
  assert.deepEqual(exports.calls, [{name: 'research.toolchain.status', request: {}}]);
  assert.equal(exports.verified(), 0);
  const ready = probe('export', () => ({available: true, versions: {tectonic: 'pinned'}, error: null}));
  await ready.service.check(ready.run, new AbortController().signal);
  assert.equal(ready.verified(), 1);
  const missing = probe('figure', () => assert.fail('Missing required capabilities must fail before probing.'));
  missing.registry.list = () => [];
  await assert.rejects(missing.service.check(missing.run, new AbortController().signal),
    /research_skill_capability_unavailable:research\.knowledge\.search/u);
  assert.deepEqual(missing.calls, []);
  const experiment = probe('experiment', () => assert.fail('An unknown experiment engine must never be guessed.'));
  await experiment.service.check(experiment.run, new AbortController().signal);
  assert.deepEqual(experiment.calls, []);
  assert.equal(experiment.verified(), 1);
});

test('a missing declared capability fails the actual queued stage before model prepare', async () => {
  const f = createResearchFixture(api, 'planning');
  let modelCalls = 0;
  const capabilities = {list: () => [], invoke: async () => assert.fail('No capability is installed.')};
  const readiness = new api.ResearchStageReadinessService(f.repository, capabilities);
  const runtime = new api.ResearchStageRuntime(f.repository, capabilities, {prepare: async () => {
    modelCalls++; assert.fail('The model must not be prepared before readiness succeeds.');
  }}, api.createResearchHumanGate({repository: f.repository}), {cancelOwned: async () => {}}, undefined, 1,
  (run, signal) => readiness.check(run, signal));
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'interrupted', 'fixture_restart');
    f.tasks.setStatus(f.run.taskId, f.project.id, 'interrupted', 'fixture_restart', ['active']);
    const next = runtime.retry({projectId: f.project.id, runId: f.run.id, requestId: 'readiness-failure'});
    await runtime.waitForIdle();
    const stopped = f.repository.runs.get(next.id, f.project.id);
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.error, 'research_skill_capability_unavailable:research.knowledge.search');
    assert.deepEqual(stopped.outputArtifactIds, []);
    assert.equal(modelCalls, 0);
  } finally {await runtime.shutdown(); await f.close();}
});
