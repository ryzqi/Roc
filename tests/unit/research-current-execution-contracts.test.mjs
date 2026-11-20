import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { createResearchFixture, figureRequest, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

const experiments = await importTypeScriptModule('src/shared/schemas/research-experiments.ts', { platform: 'node' });
const figures = await importTypeScriptModule('src/shared/schemas/research-figures.ts', { platform: 'node' });
const { getResearchFigureRendererEnvironment } = await importTypeScriptModule(
  'src/main/plugins/research/figure-renderer-environment.ts', { platform: 'node' });
let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

const fields = { projectId: 'project', requestId: 'contract', label: 'Current execution',
  sourcePath: 'analysis.mts', inputPaths: [], parameters: {}, timeoutMs: 1000, network: 'disabled' };
const typescript = { ...fields, engine: 'typescript', runtime: { kind: 'bundled-node' }, sourceVersion: 1 };
const native = (engine) => ({ ...fields, engine, arguments: [], sourcePath: engine === 'r' ? 'analysis.r' : 'analysis.jl',
  runtime: engine === 'r' ? { kind: 'renv', rootPath: '/runtime/r', libraryPath: 'renv/library' }
    : { kind: 'julia', rootPath: '/runtime/julia', depotPath: '/runtime/depot' } });
const { sourcePath: _typescriptPath, ...pythonFields } = fields;
const python = { ...pythonFields, engine: 'python', source: { kind: 'file', path: 'analysis.py' }, sourceVersion: 1, seed: 42,
  arguments: [], expectedEnvironmentHash: 'b'.repeat(64),
  runtime: { kind: 'python', selectionId: 'python_environment_selected', expectedHash: 'a'.repeat(64) } };

test('current experiment creation and stored execution use identical strict request limits', () => {
  for (const request of [typescript, native('r'), native('julia'), python]) {
    assert.deepEqual(experiments.researchExperimentStartSchema.parse(request), request);
    assert.deepEqual(experiments.researchExperimentExecutionSchema.shape.request.parse(request), request);
    for (const changed of [
      { ...request, network: 'enabled' },
      { ...request, inputPaths: Array.from({ length: 501 }, (_, i) => `input-${i}.csv`) },
      { ...request, inputPaths: ['same.csv', 'same.csv'] },
      { ...request, parameters: { data: 'x'.repeat(65536), ...Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [`data-${i}`, 'x'.repeat(65536)])) } }
    ]) {
      assert.equal(experiments.researchExperimentStartSchema.safeParse(changed).success, false);
      assert.equal(experiments.researchExperimentExecutionSchema.shape.request.safeParse(changed).success, false);
    }
  }
  for (const kind of ['bundled-python', 'uv']) {
    assert.equal(experiments.researchExperimentRuntimeSchema.safeParse({ kind }).success, false);
    assert.equal(experiments.researchExperimentEnvironmentRequestSchema.safeParse({
      projectId: 'project', runtime: { kind }
    }).success, false);
    assert.equal(experiments.researchExperimentExecutionSchema.shape.request.safeParse({
      ...fields, engine: 'python', sourcePath: 'analysis.py', runtime: { kind }, arguments: []
    }).success, false);
  }
});

test('Python inspection and starts require exact path-free selections, version, seed and preview identity', () => {
  const runtime = { kind: 'python', selectionId: 'python_environment_selected', expectedHash: 'a'.repeat(64) };
  assert.deepEqual(experiments.researchExperimentEnvironmentRequestSchema.parse({ projectId: 'project', runtime }),
    { projectId: 'project', runtime });
  for (const changed of [
    { ...runtime, selectedExecutable: '/usr/bin/python3' },
    { ...runtime, rootPath: '/runtime' },
    { ...runtime, actor: { kind: 'user', id: 'window:1' } },
    { ...runtime, expectedHash: 'wrong' },
    { kind: 'python', selectionId: runtime.selectionId },
    { kind: 'python', expectedHash: runtime.expectedHash }
  ]) assert.equal(experiments.researchExperimentRuntimeSchema.safeParse(changed).success, false);
  const { projectId: _projectId, ...owned } = python;
  assert.deepEqual(experiments.researchOwnedExperimentStartSchema.parse(owned), owned);
  assert.deepEqual(experiments.researchExperimentStartRequestSchema.parse(python), python);
  const notebook = { ...python, source: { kind: 'notebook', notebookId: 'imported-1', expectedHash: 'c'.repeat(64), subsetVersion: 1 } };
  assert.deepEqual(experiments.researchExperimentStartSchema.parse(notebook), notebook);
  const { projectId: _notebookProject, ...ownedNotebook } = notebook;
  assert.deepEqual(experiments.researchOwnedExperimentStartSchema.parse(ownedNotebook), ownedNotebook);
  for (const source of [
    { ...notebook.source, projectId: 'injected' }, { ...notebook.source, expectedHash: 'wrong' },
    { ...notebook.source, subsetVersion: 2 }, { kind: 'notebook', notebookId: 'imported-1' }
  ]) assert.equal(experiments.researchExperimentStartSchema.safeParse({ ...notebook, source }).success, false);
  const { seed: _seed, ...noSeed } = python;
  const { sourceVersion: _version, ...noVersion } = python;
  const { expectedEnvironmentHash: _environment, ...noEnvironment } = python;
  for (const changed of [noSeed, noVersion, noEnvironment, { ...python, seed: -1 }, { ...python, seed: 0x1_0000_0000 },
    { ...python, seed: 0.5 }, { ...python, sourceVersion: 2 }, { ...python, source: { kind: 'file', path: 'source.mts' } }, { ...python, sourcePath: 'analysis.py' },
    { ...python, arguments: ['\0'] }, { ...python, runtime: { ...runtime, executable: '/usr/bin/python3' } }]) {
    assert.equal(experiments.researchExperimentStartSchema.safeParse(changed).success, false);
    assert.equal(experiments.researchExperimentStartRequestSchema.safeParse(changed).success, false);
    const { projectId: _project, ...request } = changed;
    assert.equal(experiments.researchOwnedExperimentStartSchema.safeParse(request).success, false);
  }
});

test('repository refuses obsolete snapshots without rewriting or deleting retained user records', () => {
  const f = createResearchFixture(api, 'experiment');
  try {
    const run = f.repository.experiments.create({ ...typescript, projectId: f.project.id },
      f.project.workspacePath, f.project.workspacePath, '/tmp/contract-storage');
    assert.deepEqual(f.repository.experiments.get(f.project.id, run.id), run);
    for (const request of [
      { ...fields, projectId: f.project.id, engine: 'python', runtime: { kind: 'uv' }, sourcePath: 'analysis.py', arguments: [] },
      { ...native('r'), projectId: f.project.id, network: 'enabled' }
    ]) {
      const stored = JSON.stringify({ ...run, request });
      f.db.prepare('UPDATE research_experiment_executions SET snapshot_json=? WHERE run_id=?').run(stored, run.id);
      const changes = f.db.prepare('SELECT total_changes()').pluck().get();
      assert.throws(() => f.repository.experiments.get(f.project.id, run.id), /research_experiment_snapshot_invalid/);
      assert.throws(() => f.repository.experiments.list(f.project.id, 10), /research_experiment_snapshot_invalid/);
      assert.equal(f.db.prepare('SELECT snapshot_json FROM research_experiment_executions WHERE run_id=?').pluck().get(run.id), stored);
      assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
      assert.equal(f.db.prepare('SELECT count(*) FROM research_experiment_runs WHERE id=?').pluck().get(run.id), 1);
    }
  } finally { f.close(); }
});

test('figure runs require actual Vega renderer identity and never manufacture missing pipeline versions', () => {
  const current = figureRequest('project', null);
  assert.deepEqual(figures.researchFigureRunSchema.shape.request.parse(current), current);
  const { engine, sourceVersion, ...old } = current;
  assert.equal(figures.researchFigureRunSchema.shape.request.safeParse({
    ...old, sourcePath: 'figure.py', runtime: { kind: 'renv', rootPath: '/runtime/r', libraryPath: 'renv/library' },
    arguments: [], parameters: {}
  }).success, false);
  const environment = getResearchFigureRendererEnvironment();
  assert.deepEqual(figures.researchFigureRunSchema.shape.environment.parse(environment), environment);
  const { pipelineVersion, ...missing } = environment;
  assert.equal(figures.researchFigureRendererEnvironmentSchema.safeParse(missing).success, false);
  assert.equal(figures.researchFigureRunSchema.shape.environment.safeParse({
    runtime: { kind: 'bundled-node' }, executable: '/usr/bin/true', prefix: '/usr/bin', basePrefix: '/usr/bin',
    version: 'test', platform: 'darwin', architecture: 'arm64', toolchainHash: 'a'.repeat(64), metadataHash: 'a'.repeat(64),
    packages: [], lockFiles: [], hash: environment.hash
  }).success, false);
});
