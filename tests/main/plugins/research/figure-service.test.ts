import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchExperimentService } from '../../../../src/main/plugins/research/experiment-service';
import { snapshotExperimentInputs } from '../../../../src/main/plugins/research/experiment-files';
import { ResearchFigureService } from '../../../../src/main/plugins/research/figure-service';
import { createResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { createResearchProductionJob } from '../../../../src/main/plugins/research/research-production-job';
import { figureManifestPath } from '../../../../src/main/plugins/research/figure-repository';
import { figureRenderer, figureRendererPath, figureValidationPath } from '../../../../src/main/plugins/research/figure-runner';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { type ResearchExperimentEnvironment, type ResearchExperimentFile } from '../../../../src/shared/schemas/research-experiments';
import { researchFigureRunSchema, researchFigureStartSchema, type ResearchFigureStart } from '../../../../src/shared/schemas/research-figures';
import type { ResearchFigureValidation } from '../../../../src/shared/schemas/research-plotting';
import type { ResearchProcessRequest, ResearchProcessResult } from '../../../../src/main/plugins/research/process-runner';

let db: Database.Database;
let repository: ResearchRepository;
let experiments: ResearchExperimentService;
let figures: ResearchFigureService;
let gate: ReturnType<typeof createResearchHumanGate>;
let root: string;
let workspace: string;
let projectId: string;
const options = { widthInches: 4, heightInches: 3, dpi: 150, seed: 42 };
const environment: ResearchExperimentEnvironment = { runtime: { kind: 'bundled-python' }, executable: '/toolchain/python', prefix: '/toolchain', basePrefix: '/toolchain',
  version: '3.12.14', platform: 'darwin', architecture: 'arm64', toolchainHash: 'a'.repeat(64), metadataHash: 'b'.repeat(64), packages: [{ name: 'matplotlib', version: '3.11.1' }], lockFiles: [], hash: 'c'.repeat(64) };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-figure-')));
  workspace = join(root, 'workspace'); await mkdir(workspace);
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Plots', description: 'Verified figure publications.', workspacePath: workspace }).id;
  experiments = new ResearchExperimentService(repository, { inspect: async () => { throw new Error('unexpected_environment_probe'); } }, join(root, 'runs'),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  figures = new ResearchFigureService(repository, experiments, join(root, 'runs'), { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  gate = createResearchHumanGate({
    repository,
    production: createResearchProductionJob({
      repository,
      experiments,
      figures,
      exports: { recover() {}, async verifyStage() { throw new Error('unexpected_export_verify'); }, async shutdown() {} }
    })
  });
});
afterEach(async () => { await Promise.all([figures.shutdown(), experiments.shutdown()]); db.close(); await rm(root, { recursive: true, force: true }); });

function request(): ResearchFigureStart {
  return { projectId, requestId: randomUUID(), label: 'Measured response', runtime: { kind: 'bundled-python' }, sourcePath: 'plot.py',
    inputPaths: ['data.csv'], arguments: [], parameters: {}, expectedEnvironmentHash: environment.hash, timeoutMs: 10000, figure: options };
}
function enterFigure(): void { repository.transitionWorkflow({ projectId, expectedStage: 'discovery', action: 'move', targetStage: 'figure' }); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

async function completedRun() {
  const initial = repository.figureRuns.create(request(), workspace, workspace, join(root, 'runs'));
  const entries: Array<{ area: ResearchExperimentFile['area']; path: string; content: string }> = [
    { area: 'input', path: 'plot.py', content: 'figure = build_figure()' }, { area: 'input', path: 'data.csv', content: 'value\n42\n' },
    { area: 'input', path: figureRendererPath, content: figureRenderer },
    ...(['png', 'svg', 'pdf'] as const).map((format) => ({ area: 'output' as const, path: `figure.${format}`, content: `${format} unit fixture` }))
  ];
  const file = (entry: typeof entries[number]): ResearchExperimentFile => ({ area: entry.area, path: entry.path, sha256: researchContentHash(entry.content), size: Buffer.byteLength(entry.content) });
  const validation: ResearchFigureValidation = { options, rendererHash: researchContentHash(figureRenderer), widthPixels: 600, heightPixels: 450, widthPoints: 288, heightPoints: 216, pageCount: 1,
    files: (['png', 'svg', 'pdf'] as const).map((format) => ({ path: `figure.${format}`, sha256: researchContentHash(`${format} unit fixture`), size: Buffer.byteLength(`${format} unit fixture`) })) };
  entries.push({ area: 'output', path: figureValidationPath, content: JSON.stringify(validation) });
  const runRoot = repository.figureRuns.root(projectId, initial.id);
  for (const entry of entries) {
    const destination = join(runRoot, entry.area, entry.path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, entry.content);
  }
  repository.figureRuns.start(projectId, initial.id, environment, entries.filter((entry) => entry.area === 'input').map(file), researchContentHash('fixture inputs'));
  const run = repository.figureRuns.finish(projectId, initial.id, { status: 'completed', files: entries.map(file), exitCode: 0, error: null });
  return { run, validation, runRoot };
}

function support(artifactId: string) {
  repository.knowledge.upsertKnowledgeDocument({ id: randomUUID(), projectId, sourceType: 'file', sourceId: 'data.csv', title: 'Measurements', content: 'Measured response 42.',
    chunks: [{ content: 'Measured response 42.', locator: 'row 2' }], embeddingConfigId: null });
  const row = db.prepare('SELECT id FROM research_knowledge_chunks ORDER BY rowid DESC LIMIT 1').get() as { id: string };
  const evidence = repository.evidence.capture({ projectId, chunkId: row.id });
  return repository.evidence.createClaim({ projectId, artifactId, subjectType: 'figure', content: 'Measured response 42.', status: 'supported', evidenceIds: [evidence.id] });
}

describe('figure publication and review boundaries', () => {
  it('keeps matplotlib environment and renderer rules inside the figure runner', async () => {
    const inspect = vi.fn();
    const runProcess = vi.fn<(input: ResearchProcessRequest) => Promise<ResearchProcessResult>>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const liveExperiments = new ResearchExperimentService(repository, { inspect }, join(root, 'runs'), { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, runProcess);
    const liveFigures = new ResearchFigureService(repository, liveExperiments, join(root, 'runs'), { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    inspect.mockResolvedValueOnce({ snapshot: { ...environment, packages: [] }, readablePaths: ['/toolchain'], environment: { PATH: '/toolchain' }, python: '/toolchain/python' });
    await writeFile(join(workspace, 'plot.py'), 'figure = make_figure()');
    const figureRequest = { projectId, requestId: randomUUID(), label: 'Measured response', runtime: { kind: 'bundled-python' as const }, sourcePath: 'plot.py',
      inputPaths: [], arguments: [], parameters: {}, expectedEnvironmentHash: environment.hash, timeoutMs: 10000, figure: options };
    const missing = await liveFigures.start(figureRequest);
    await vi.waitFor(() => expect(['preparing', 'running']).not.toContain(repository.figureRuns.get(projectId, missing.id).status));
    expect(repository.figureRuns.get(projectId, missing.id)).toMatchObject({ status: 'failed', error: 'research_figure_matplotlib_required' });
    inspect.mockResolvedValue({ snapshot: environment, readablePaths: ['/toolchain'], environment: { PATH: '/toolchain' }, python: '/toolchain/python' });
    const { expectedEnvironmentHash: _hash, ...withoutHash } = figureRequest;
    const omitted = await liveFigures.start({ ...withoutHash, requestId: randomUUID() });
    await vi.waitFor(() => expect(['preparing', 'running']).not.toContain(repository.figureRuns.get(projectId, omitted.id).status));
    expect(repository.figureRuns.get(projectId, omitted.id).error).toBe('research_figure_validation_failed');
    const started = await liveFigures.start({ ...figureRequest, requestId: randomUUID() });
    await vi.waitFor(() => expect(['preparing', 'running']).not.toContain(repository.figureRuns.get(projectId, started.id).status));
    expect(repository.figureRuns.get(projectId, started.id)).toMatchObject({ status: 'failed', error: 'research_figure_validation_failed' });
    const processRequest = runProcess.mock.calls.at(0)?.at(0);
    if (processRequest === undefined) {
      throw new Error('figure_process_request_missing');
    }
    expect(processRequest?.args).toEqual(expect.arrayContaining(['render', expect.stringContaining('.roc/figure.py')]));
    expect(processRequest?.environment).toMatchObject({ SOURCE_DATE_EPOCH: '0', PYTHONHASHSEED: '0' });
    await Promise.all([liveFigures.shutdown(), liveExperiments.shutdown()]);
  });

  it('requires explicit valid plotting settings and rejects oversized renders', () => {
    const value = { projectId, requestId: request().requestId, label: 'Measured response', runtime: { kind: 'bundled-python' as const },
      sourcePath: 'plot.py', inputPaths: ['data.csv'], arguments: [], parameters: {}, expectedEnvironmentHash: environment.hash, timeoutMs: 10000, figure: options };
    expect(researchFigureStartSchema.safeParse({ ...value, figure: undefined }).success).toBe(false);
    expect(researchFigureStartSchema.safeParse({ ...value, sourcePath: 'plot.r' }).success).toBe(false);
    expect(researchFigureStartSchema.safeParse({ ...value, runtime: { kind: 'renv', rootPath: '/r', libraryPath: 'renv/library' } }).success).toBe(false);
    expect(researchFigureStartSchema.safeParse({ ...value, figure: { ...options, dpi: 1200, widthInches: 24 } }).success).toBe(false);
  });

  it('freezes the renderer, includes render settings in input identity and rejects a colliding user input', async () => {
    await writeFile(join(workspace, 'plot.py'), 'figure = make_figure()');
    await writeFile(join(workspace, 'data.csv'), 'value\n42\n');
    const firstRoot = join(root, 'first-input'); const secondRoot = join(root, 'second-input');
    await mkdir(firstRoot); await mkdir(secondRoot);
    const generated = { [figureRendererPath]: figureRenderer };
    const signal = new AbortController().signal;
    const first = await snapshotExperimentInputs(workspace, firstRoot, request(), environment, signal, generated);
    const second = await snapshotExperimentInputs(workspace, secondRoot, { ...request(), figure: { ...options, seed: 43 } }, environment, signal, generated);
    expect(first.files).toEqual(second.files);
    expect(first.hash).not.toBe(second.hash);
    expect(await readFile(join(firstRoot, figureRendererPath), 'utf8')).toBe(figureRenderer);
    await expect(snapshotExperimentInputs(workspace, firstRoot, { ...request(), inputPaths: [figureRendererPath] }, environment, signal, generated))
      .rejects.toThrow('research_experiment_reserved_input');
  });

  it('publishes a traceable immutable figure exactly once and retains sources after the project changes', async () => {
    const { run } = await completedRun(); enterFigure();
    const first = await figures.publish(projectId, run.id, null);
    expect(await figures.publish(projectId, run.id, null)).toEqual(first);
    expect(repository.figures.list(projectId, 10)).toEqual([first]);
    expect(repository.listProvenance({ projectId, subjectId: first.id })).toMatchObject([{ sourceType: 'experiment', sourceId: run.id, artifactId: first.artifactId }]);
    expect(() => repository.updateArtifact({ id: first.artifactId, path: '/unverified.png' })).toThrow('research_figure_publication_immutable');
    expect(() => repository.figures.record({ id: first.id, projectId, title: 'Forged', codePath: 'other.py', dataPaths: [], outputPaths: [], status: 'approved', runId: null }))
      .toThrow('research_figure_publication_immutable');
    await rm(workspace, { recursive: true });
    expect(await figures.verify(projectId, first.id)).toEqual(first);
    const png = first.validation.files.find((entry) => entry.path === 'figure.png')!;
    expect((await figures.source({ projectId, figureId: first.id, format: 'png', sha256: png.sha256 })).toString()).toBe('png unit fixture');
  });

  it('rolls back figure records and provenance when the current stage cannot accept the publication', async () => {
    const { run } = await completedRun();
    await expect(figures.publish(projectId, run.id, null)).rejects.toThrow('research_artifact_stage_inactive');
    expect(db.prepare('SELECT count(*) AS count FROM research_figures').get()).toEqual({ count: 0 });
    expect(repository.listArtifacts(projectId)).toEqual([]);
    expect(repository.figures.list(projectId, 10)).toEqual([]);
  });

  it('rejects changed outputs and tampered or missing publication manifests', async () => {
    const { run, runRoot } = await completedRun(); enterFigure();
    const original = await readFile(join(runRoot, 'output/figure.png'));
    await writeFile(join(runRoot, 'output/figure.png'), 'changed');
    await expect(figures.publish(projectId, run.id, null)).rejects.toThrow('research_figure_snapshot_changed');
    await writeFile(join(runRoot, 'output/figure.png'), original);
    const figure = await figures.publish(projectId, run.id, null);
    const manifestPath = join(runRoot, figureManifestPath);
    const manifest = await readFile(manifestPath);
    await chmod(manifestPath, 0o600); await writeFile(manifestPath, 'changed');
    await expect(figures.verify(projectId, figure.id)).rejects.toThrow('research_figure_manifest_changed');
    await expect(figures.publish(projectId, run.id, null)).rejects.toThrow('research_figure_manifest_changed');
    await writeFile(manifestPath, manifest); await rm(manifestPath);
    await expect(figures.verify(projectId, figure.id)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires evidence and manual approval, then exposes superseded history when the workflow returns', async () => {
    const { run } = await completedRun(); enterFigure();
    const figure = await figures.publish(projectId, run.id, null);
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'start' });
    expect(() => repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'complete' })).toThrow('research_figure_evidence_required');
    support(figure.artifactId); await figures.verifyStage(projectId);
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'complete' });
    expect(repository.figures.get(projectId, figure.id).status).toBe('rendered');
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'approve' });
    expect(repository.figures.get(projectId, figure.id).status).toBe('approved');
    repository.transitionWorkflow({ projectId, expectedStage: 'writing', action: 'move', targetStage: 'figure' });
    expect(repository.figures.get(projectId, figure.id).status).toBe('superseded');
  });

  it('replaces a rejected draft atomically while preserving its claims and excluding it from the next approval', async () => {
    const firstRun = await completedRun(); const secondRun = await completedRun(); enterFigure();
    const first = await figures.publish(projectId, firstRun.run.id, null);
    const claim = support(first.artifactId);
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'start' });
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'complete' });
    await expect(figures.publish(projectId, secondRun.run.id, first.id)).rejects.toThrow('research_stage_not_editable');
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'reject', note: 'Adjust the plot.' });
    const second = await figures.publish(projectId, secondRun.run.id, first.id);
    expect(repository.figures.get(projectId, first.id).status).toBe('superseded');
    expect(repository.evidence.getClaim(claim.id).content).toBe('Measured response 42.');
    expect(repository.getWorkflow(projectId).stages.find((stage) => stage.stage === 'figure')?.artifactIds).toEqual([second.artifactId]);
    expect(repository.evidence.listClaims({ projectId, artifactId: second.artifactId })).toEqual([]);
    expect(await figures.publish(projectId, secondRun.run.id, first.id)).toEqual(second);
    await expect(figures.publish(projectId, secondRun.run.id, null)).rejects.toThrow('research_figure_publish_conflict');
  });

  it('rejects cross-project reads, legacy rewrites and failed runs as figures', async () => {
    const { run } = await completedRun(); enterFigure();
    const figure = await figures.publish(projectId, run.id, null);
    const other = repository.createProject({ title: 'Other', description: '', workspacePath: join(root, 'other-figure') });
    expect(() => repository.figures.get(other.id, figure.id)).toThrow('research_figure_project_mismatch');
    await expect(figures.publish(other.id, run.id, null)).rejects.toThrow('research_figure_project_mismatch');
    repository.figures.record({ id: 'legacy', projectId, title: 'Legacy', codePath: 'plot.py', dataPaths: [], outputPaths: [], status: 'draft', runId: null });
    expect(() => repository.figures.record({ id: 'legacy', projectId: other.id, title: 'Changed', codePath: 'x', dataPaths: [], outputPaths: [], status: 'draft', runId: null }))
      .toThrow('research_figure_project_mismatch');
    const pending = repository.figureRuns.create(request(), workspace, workspace, join(root, 'runs'));
    repository.figureRuns.finish(projectId, pending.id, { status: 'cancelled', files: [], exitCode: null, error: 'research_figure_cancelled' });
    await expect(figures.publish(projectId, pending.id, null)).rejects.toThrow('research_figure_completed_required');
  });

  it('blocks late publication after shutdown without adding workflow artifacts', async () => {
    const { run } = await completedRun(); enterFigure();
    const read = repository.figureRuns.get.bind(repository.figureRuns);
    vi.spyOn(repository.figureRuns, 'get').mockImplementationOnce((...args) => { const result = read(...args); void figures.shutdown(); return result; });
    await expect(figures.publish(projectId, run.id, null)).rejects.toThrow('research_figure_service_closed');
    expect(repository.figures.list(projectId, 10)).toEqual([]);
  });

  it('rejects stale approval when the reviewed figure is replaced during verification', async () => {
    const firstRun = await completedRun(); const secondRun = await completedRun(); enterFigure();
    const first = await figures.publish(projectId, firstRun.run.id, null); support(first.artifactId);
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'start' });
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'complete' });
    const reached = deferred(); const release = deferred(); const verify = figures.verify.bind(figures);
    vi.spyOn(figures, 'verify').mockImplementationOnce(async (...args) => { const result = await verify(...args); reached.resolve(); await release.promise; return result; });
    const pending = gate.approve({ projectId, expectedStage: 'figure', action: 'approve' });
    const assertion = expect(pending).rejects.toThrow('research_figure_review_changed');
    await reached.promise;
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'reject', note: 'Replace the reviewed plot.' });
    const second = await figures.publish(projectId, secondRun.run.id, first.id); support(second.artifactId);
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'complete' });
    release.resolve(); await assertion;
    expect(repository.figures.get(projectId, second.id).status).toBe('rendered');
  });

  it('does not approve a figure when shutdown begins after its file verification', async () => {
    const { run } = await completedRun(); enterFigure();
    const figure = await figures.publish(projectId, run.id, null); support(figure.artifactId);
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'start' });
    repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'complete' });
    const reached = deferred(); const release = deferred(); const verify = figures.verify.bind(figures);
    vi.spyOn(figures, 'verify').mockImplementationOnce(async (...args) => { const result = await verify(...args); reached.resolve(); await release.promise; return result; });
    const pending = gate.approve({ projectId, expectedStage: 'figure', action: 'approve' });
    const assertion = expect(pending).rejects.toThrow('research_figure_service_closed');
    await reached.promise;
    const closing = figures.shutdown();
    release.resolve(); await closing; await assertion;
    expect(repository.figures.get(projectId, figure.id).status).toBe('rendered');
  });

  it('migrates v10 legacy figures without fabricating verified renders or changing their records', () => {
    const old = new Database(':memory:');
    try {
      old.pragma('foreign_keys = ON');
      applyDatabaseMigrations(old, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 10) });
      const legacy = new ResearchRepository(old);
      const project = legacy.createProject({ title: 'Legacy', description: '', workspacePath: '/tmp/figure-service.test-1' });
      old.prepare("INSERT INTO research_figures VALUES ('legacy',?,'Old plot','plot.py','[]','[\"old.png\"]','approved',NULL,'old','old')").run(project.id);
      applyResearchDatabaseSchema(old); applyResearchDatabaseSchema(old);
      expect(legacy.figures.list(project.id, 10)).toEqual([]);
      expect(old.prepare('SELECT title,status,output_paths_json FROM research_figures').get()).toEqual({ title: 'Old plot', status: 'approved', output_paths_json: '["old.png"]' });
    } finally { old.close(); }
  });

  it('moves stored matplotlib executions into figure runs without experiment fields', () => {
    const old = new Database(':memory:');
    try {
      old.pragma('foreign_keys = ON');
      applyDatabaseMigrations(old, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 16) });
      const legacy = new ResearchRepository(old);
      const project = legacy.createProject({ title: 'Legacy figure', description: '', workspacePath: '/tmp/figure-service.test-2' });
      const snapshot = {
        id: 'experiment_old', projectId: project.id,
        request: {
          projectId: project.id, requestId: 'req_old', label: 'Old figure', engine: 'matplotlib', runtime: { kind: 'bundled-python' },
          sourcePath: 'plot.py', inputPaths: [], arguments: [], parameters: {}, timeoutMs: 10000, network: 'disabled',
          figure: { widthInches: 4, heightInches: 3, dpi: 150, seed: 1 }
        },
        ownerRunId: null, workspacePath: '/tmp/figure-service.test-2', workspaceRoot: '/tmp/figure-service.test-2', status: 'completed',
        environment: null, files: [], inputHash: null, exitCode: 0, error: null, artifactId: null,
        createdAt: 'old', startedAt: null, endedAt: 'old'
      };
      old.prepare("INSERT INTO research_experiment_runs VALUES ('experiment_old',?,'Old figure','[]','{}','{}','completed','[]','old','old')").run(project.id);
      old.prepare("INSERT INTO research_experiment_executions VALUES ('experiment_old',?,'req_old','completed',?,?,'old')").run(project.id, JSON.stringify(snapshot), '/tmp/root/experiment_old');
      old.prepare("INSERT INTO research_figures VALUES ('figure_old',?,'Old figure','input/plot.py','[]','[]','rendered','experiment_old','old','old')").run(project.id);
      old.prepare("INSERT INTO research_artifacts VALUES ('artifact_old',?,'figure','figure','Old figure',?, 'draft','old','old')").run(project.id, '/tmp/root/experiment_old/figure-manifest.json');
      old.prepare("INSERT INTO research_figure_publications VALUES ('figure_old',?,'experiment_old','artifact_old','{}','old')").run(project.id);
      applyResearchDatabaseSchema(old);
      expect(old.prepare('SELECT count(*) AS count FROM research_experiment_executions').get()).toEqual({ count: 0 });
      expect(old.prepare('SELECT count(*) AS count FROM research_figure_publications').get()).toEqual({ count: 1 });
      const row = old.prepare('SELECT snapshot_json FROM research_figure_runs').get() as { snapshot_json: string };
      const migrated = researchFigureRunSchema.parse(JSON.parse(row.snapshot_json));
      expect(migrated.request.figure.seed).toBe(1);
      expect(migrated.request).not.toHaveProperty('engine');
      expect(migrated.request).not.toHaveProperty('network');
      expect(legacy.figureRuns.get(project.id, 'experiment_old').id).toBe('experiment_old');
    } finally { old.close(); }
  });
});
