import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResearchTestRoleTools, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

test('actual start tool replays unchanged work but executes revised source and input bytes at the same paths', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-start-identity-')));
  const f = createResearchFixture(api, 'experiment', directory);
  try {
    const files = new api.ResearchWorkspaceFileService(f.db, f.repository, () => f.run.createdAt);
    const effects = new api.ResearchProductionEffectService(f.repository, files, {
      async start(request) {
        return f.repository.experiments.create(request, directory, directory, directory);
      }
    });
    const tools = createResearchTestRoleTools(api, {run: f.run, context: f.repository.runs.getContext(f.run.id),
      repository: f.repository, capabilities: {}, effects, signal: new AbortController().signal});
    const save = tools.find(tool => tool.name === 'save_workspace_file');
    const start = tools.find(tool => tool.name === 'start_experiment');
    const script = await save.invoke({path: 'fixture.mts', content: 'export async function run() { return 1; }', expectedHash: null});
    const data = await save.invoke({path: 'input.csv', content: 'value\n1\n', expectedHash: null});
    const request = {requestId: 'revision-one', label: 'Engineering fixture', engine: 'typescript',
      runtime: {kind: 'bundled-node'}, sourceVersion: 1, sourcePath: 'fixture.mts', inputPaths: ['input.csv'],
      parameters: {}, timeoutMs: 1000, network: 'disabled'};
    const first = await start.invoke(request);
    assert.equal((await start.invoke({...request, requestId: 'same-bytes-new-attempt'})).experimentId, first.experimentId);
    await save.invoke({path: 'fixture.mts', content: 'export async function run() { return 2; }', expectedHash: script.sha256});
    const revised = await start.invoke({...request, requestId: 'revision-two'});
    assert.notEqual(revised.experimentId, first.experimentId, 'changed source must not replay the old receipt');
    assert.equal((await start.invoke({...request, requestId: 'revision-two-retry'})).experimentId, revised.experimentId);
    await save.invoke({path: 'input.csv', content: 'value\n2\n', expectedHash: data.sha256});
    const changedInput = await start.invoke({...request, requestId: 'changed-input'});
    assert.notEqual(changedInput.experimentId, revised.experimentId, 'changed input bytes must create distinct work');
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_experiment_runs').pluck().get(), 3);
  } finally { f.close(); await rm(directory, {recursive: true, force: true}); }
});

test('figure starts also distinguish changed spec bytes while unchanged retries remain idempotent', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-figure-start-identity-')));
  const f = createResearchFixture(api, 'figure', directory);
  try {
    const files = new api.ResearchWorkspaceFileService(f.db, f.repository, () => f.run.createdAt);
    const effects = new api.ResearchProductionEffectService(f.repository, files, undefined, {
      async start(request) { return f.repository.figureRuns.create(request, directory, directory, directory); }
    });
    const tools = createResearchTestRoleTools(api, {run: f.run, context: f.repository.runs.getContext(f.run.id),
      repository: f.repository, capabilities: {}, effects, signal: new AbortController().signal});
    const save = tools.find(tool => tool.name === 'save_workspace_file');
    const start = tools.find(tool => tool.name === 'start_figure');
    const spec = await save.invoke({path: 'figure.vl.json', content: '{"mark":"point"}', expectedHash: null});
    const request = {requestId: 'figure-one', label: 'Engineering figure', engine: 'vega-lite', sourceVersion: 1,
      sourcePath: 'figure.vl.json', inputPaths: [], timeoutMs: 1000,
      figure: {widthInches: 3, heightInches: 2, dpi: 72, seed: 42}};
    const first = await start.invoke(request);
    assert.equal((await start.invoke({...request, requestId: 'same-figure'})).runId, first.runId);
    await save.invoke({path: 'figure.vl.json', content: '{"mark":"bar"}', expectedHash: spec.sha256});
    const revised = await start.invoke({...request, requestId: 'figure-two'});
    assert.notEqual(revised.runId, first.runId);
    assert.equal((await start.invoke({...request, requestId: 'same-revised-figure'})).runId, revised.runId);
    await rm(join(directory, 'figure.vl.json'));
    await assert.rejects(start.invoke({...request, requestId: 'missing-source'}));
    assert.equal(f.agentDb.prepare("SELECT COUNT(*) FROM agent_tool_effects WHERE tool_name='start_figure'").pluck().get(), 2);
  } finally { f.close(); await rm(directory, {recursive: true, force: true}); }
});

test('start input identity remains owner fenced and late cancellation cannot replay a prior success', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-start-identity-fence-')));
  const f = createResearchFixture(api, 'experiment', directory);
  try {
    const files = new api.ResearchWorkspaceFileService(f.db, f.repository, () => f.run.createdAt);
    const effects = new api.ResearchProductionEffectService(f.repository, files, {
      async start(request) { return f.repository.experiments.create(request, directory, directory, directory); }
    });
    const tools = createResearchTestRoleTools(api, {run: f.run, context: f.repository.runs.getContext(f.run.id),
      repository: f.repository, capabilities: {}, effects, signal: new AbortController().signal});
    await tools.find(tool => tool.name === 'save_workspace_file').invoke({path: 'fixture.mts', content: 'export function run() {}', expectedHash: null});
    const request = {requestId: 'first', label: 'Fixture', engine: 'typescript', runtime: {kind: 'bundled-node'},
      sourceVersion: 1, sourcePath: 'fixture.mts', inputPaths: [], parameters: {}, timeoutMs: 1000, network: 'disabled'};
    const start = tools.find(tool => tool.name === 'start_experiment');
    await start.invoke(request);
    await assert.rejects(f.withWorker(() => effects.readStartInputIdentity(f.run.id, 'foreign-project', request)));
    const readIdentity = effects.readStartInputIdentity.bind(effects);
    effects.readStartInputIdentity = async (...args) => {
      const identity = await readIdentity(...args);
      f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture-cancelled');
      return identity;
    };
    await assert.rejects(start.invoke({...request, requestId: 'late-retry'}), /research_run_not_current/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_experiment_runs').pluck().get(), 1);
  } finally { f.close(); await rm(directory, {recursive: true, force: true}); }
});
