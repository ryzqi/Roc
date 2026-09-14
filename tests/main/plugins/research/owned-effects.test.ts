import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { ResearchExperimentService } from '../../../../src/main/plugins/research/experiment-service';
import type { PreparedExperimentEnvironment } from '../../../../src/main/plugins/research/experiment-environment';
import { ResearchExportService } from '../../../../src/main/plugins/research/export-service';
import { ResearchFigureService } from '../../../../src/main/plugins/research/figure-service';
import { ResearchProductionEffectService } from '../../../../src/main/plugins/research/production-effects';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { createResearchRoleTools } from '../../../../src/main/plugins/research/role-tools';
import { ResearchTemplateService } from '../../../../src/main/plugins/research/template-service';
import { ResearchWorkspaceFileService } from '../../../../src/main/plugins/research/workspace-files';
import type { ResearchProcessRequest, ResearchProcessResult } from '../../../../src/main/plugins/research/process-runner';
import type { ResearchExperimentStart } from '../../../../src/shared/schemas/research-experiments';
import { getResearchStageRoleProfile } from '../../../../src/main/plugins/research/role-profiles';

let db: Database.Database;
let repository: ResearchRepository;
let experiments: ResearchExperimentService;
let figures: ResearchFigureService;
let templates: ResearchTemplateService;
let exports: ResearchExportService;
let effects: ResearchProductionEffectService;
let files: ResearchWorkspaceFileService;
let root: string;
let workspace: string;
let projectId: string;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const inspect = vi.fn(async (): Promise<PreparedExperimentEnvironment> => environment);
const runProcess = vi.fn<(input: ResearchProcessRequest) => Promise<ResearchProcessResult>>();
const environment: PreparedExperimentEnvironment = {
  snapshot: { runtime: { kind: 'bundled-python' }, executable: '/python/bin/python', prefix: '/python', basePrefix: '/python', version: '3.12.14',
    platform: 'darwin', architecture: 'arm64', toolchainHash: 'a'.repeat(64), metadataHash: 'a'.repeat(64), packages: [], lockFiles: [], hash: 'b'.repeat(64) },
  readablePaths: ['/python'], environment: { PATH: '/python/bin:/usr/bin' }, python: '/python/bin/python'
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-owned-effects-')));
  workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'run.py'), 'print("source v1")');
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Owned effects', description: 'Bind production writes to a stage run.', workspacePath: workspace }).id;
  inspect.mockReset().mockResolvedValue(environment);
  runProcess.mockReset().mockImplementation(async (input) => {
    const directory = input.environment.ROC_OUTPUT_DIR;
    if (directory === undefined) throw new Error('output_directory_required');
    await writeFile(join(directory, 'result.csv'), 'measurement\n42\n');
    return { exitCode: 0, stdout: 'Measured signal 42.\n', stderr: '' };
  });
  experiments = new ResearchExperimentService(repository, { inspect }, join(root, 'runs'), logger, runProcess);
  figures = new ResearchFigureService(repository, experiments);
  templates = new ResearchTemplateService(repository, { compile: async () => { throw new Error('compile_unused'); }, extractTemplate: async () => { throw new Error('zip_unused'); } });
  exports = new ResearchExportService(repository, { capture: async () => { throw new Error('export_unused'); }, assertCurrent: () => { throw new Error('export_unused'); } },
    { status: async () => ({ available: false, versions: null, error: 'research_toolchain_unavailable' }), identity: async () => 'a'.repeat(64),
      experimentRuntime: async () => { throw new Error('unused'); }, compile: async () => { throw new Error('unused'); },
      writeBibliography: async () => ({ filename: 'references.bib', content: '' }), renderPdf: async () => { throw new Error('unused'); } },
    join(root, 'exports'), logger);
  files = new ResearchWorkspaceFileService(db, repository, () => new Date().toISOString());
  effects = new ResearchProductionEffectService(repository, files, experiments, figures, templates, exports);
});
afterEach(async () => { await Promise.all([exports.shutdown(), figures.shutdown(), experiments.shutdown(), templates.shutdown()]); db.close(); await rm(root, { recursive: true, force: true }); });

function experimentRequest(input: Partial<ResearchExperimentStart> = {}): Omit<ResearchExperimentStart, 'projectId' | 'ownerRunId'> {
  return { requestId: randomUUID(), label: 'Signal experiment', engine: 'python', runtime: { kind: 'bundled-python' }, sourcePath: 'run.py',
    inputPaths: [], arguments: [], parameters: {}, expectedEnvironmentHash: environment.snapshot.hash, timeoutMs: 10000, network: 'disabled', ...input };
}
function runningOwner(stage: 'experiment' | 'figure' | 'export' = 'experiment') {
  if (repository.getWorkflow(projectId).currentStage !== stage) {
    repository.transitionWorkflow({ projectId, expectedStage: repository.getWorkflow(projectId).currentStage, action: 'move', targetStage: stage });
  }
  const queued = repository.runs.begin({ projectId, expectedStage: stage, instruction: 'Produce results.', requestId: randomUUID() });
  return repository.runs.markRunning(queued.id, projectId, { providerId: 'test-provider', modelId: 'test-model' });
}
function toolsFor(run = runningOwner()) {
  const controller = new AbortController();
  const tools = createResearchRoleTools({ run, context: repository.runs.getContext(run.id), repository, capabilities: new CapabilityRegistry(), signal: controller.signal, effects });
  const get = (name: string) => { const tool = tools.find((tool) => tool.name === name); if (tool === undefined) throw new Error(`tool_required:${name}`); return tool; };
  return { run, controller, get };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('owned production effects', () => {
  it('binds experiment start, versioned script edits and publication to the current stage run', async () => {
    const { run, get } = toolsFor();
    expect(getResearchStageRoleProfile('experiment').allowedCapabilities).toEqual(expect.arrayContaining([
      'research.workspace.saveFile', 'research.experiment.startOwned', 'research.experiment.publishOwned'
    ]));
    const original = await get('read_workspace_file').invoke({ path: 'run.py', offset: 0, limit: 8000 });
    const saved = await get('save_workspace_file').invoke({ path: 'run.py', content: 'print("source v2")', expectedHash: original.sha256 });
    expect(saved.revision).toBe(1);
    await expect(get('save_workspace_file').invoke({ path: 'run.py', content: 'stale', expectedHash: original.sha256 })).rejects.toThrow('research_workspace_file_conflict');
    const started = await get('start_experiment').invoke(experimentRequest({ requestId: 'owned-start' }));
    expect(started).toMatchObject({ requestId: 'owned-start', ownerRunId: run.id });
    expect(['preparing', 'running', 'completed']).toContain(started.status);
    expect((await get('start_experiment').invoke(experimentRequest({ requestId: 'owned-start' }))).experimentId).toBe(started.experimentId);
    await expect(get('start_experiment').invoke(experimentRequest({ requestId: 'owned-start', parameters: { scale: '3' } }))).rejects.toThrow('research_experiment_request_conflict');
    await vi.waitFor(() => expect(repository.experiments.get(projectId, started.experimentId).status).toBe('completed'), { timeout: 5000 });
    const published = await get('publish_experiment').invoke({ experimentId: started.experimentId });
    expect(published.artifactId).not.toBeNull();
    expect(repository.experiments.get(projectId, started.experimentId).ownerRunId).toBe(run.id);
  });

  it('rejects model-supplied project identity and a foreign experiment publication', async () => {
    const first = toolsFor();
    await expect(first.get('start_experiment').invoke({ ...experimentRequest(), projectId: 'forged' })).rejects.toThrow();
    repository.runs.terminate(first.run.id, projectId, 'cancelled', 'research_run_cancelled');
    const owner = runningOwner();
    const started = await effects.startExperiment(owner.id, projectId, experimentRequest());
    await vi.waitFor(() => expect(repository.experiments.get(projectId, started.id).status).toBe('completed'), { timeout: 5000 });
    repository.runs.terminate(owner.id, projectId, 'cancelled', 'research_run_cancelled');
    const { get } = toolsFor();
    await expect(get('publish_experiment').invoke({ experimentId: started.id })).rejects.toThrow('research_production_owner_mismatch');
    await expect(get('get_experiment').invoke({ experimentId: started.id })).rejects.toThrow('research_production_owner_mismatch');
  });

  it('cancels a late experiment result and refuses publication after the owner run is replaced', async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    runProcess.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { exitCode: 0, stdout: 'late result\n', stderr: '' }; });
    const { run, get } = toolsFor();
    const started = await get('start_experiment').invoke(experimentRequest());
    await entered.promise;
    repository.runs.terminate(run.id, projectId, 'cancelled', 'research_run_cancelled');
    const cancelling = effects.cancelOwned(projectId, run.id);
    release.resolve();
    await cancelling;
    expect(repository.experiments.get(projectId, started.experimentId)).toMatchObject({ status: 'cancelled', artifactId: null });
    await expect(get('publish_experiment').invoke({ experimentId: started.experimentId })).rejects.toThrow('research_run_not_current');
  });

  it('rejects a late workspace write after cancellation', async () => {
    const { run, get } = toolsFor();
    const original = await files.read(projectId, 'run.py');
    repository.runs.terminate(run.id, projectId, 'cancelled', 'research_run_cancelled');
    await expect(get('save_workspace_file').invoke({ path: 'run.py', content: 'print("late")', expectedHash: original.sha256 }))
      .rejects.toThrow('research_run_not_current');
    expect(await readFile(join(workspace, 'run.py'), 'utf8')).toBe('print("source v1")');
  });

  it('rejects a late template compile and file write after the owner run is cancelled', async () => {
    const source = join(root, 'template-source');
    await mkdir(source);
    await writeFile(join(source, 'main.tex'), '\\documentclass{article}\nOriginal');
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const original = await templates.readFile({ projectId, templateId: template.id, path: 'main.tex' });
    const entered = deferred<void>(); const release = deferred<void>();
    const owned = new ResearchTemplateService(repository, {
      compile: async (input) => {
        entered.resolve();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(input.signal?.reason ?? new Error('research_process_cancelled'));
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener('abort', abort, { once: true });
          void release.promise.then(resolve, reject);
        });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      extractTemplate: async () => { throw new Error('zip_unused'); }
    });
    const ownedEffects = new ResearchProductionEffectService(repository, files, experiments, figures, owned, exports);
    const run = runningOwner();
    const compiling = ownedEffects.compileTemplate(run.id, projectId, template.id);
    await entered.promise;
    repository.runs.terminate(run.id, projectId, 'cancelled', 'research_run_cancelled');
    owned.abortOwned(run.id);
    release.resolve();
    await expect(compiling).rejects.toThrow('research_run_not_current');
    expect(owned.get({ projectId, templateId: template.id })).toMatchObject({ status: 'failed', pdfPath: null, activeCompileId: null });
    await expect(ownedEffects.saveTemplateFile(run.id, projectId, {
      templateId: template.id, path: 'main.tex', content: '\\documentclass{article}\nLate', expectedHash: original.sha256
    })).rejects.toThrow('research_run_not_current');
    expect((await owned.readFile({ projectId, templateId: template.id, path: 'main.tex' })).content).toContain('Original');
    await owned.shutdown();
  });

  it('backfills ownerRunId for v13 executions and keeps unpublished work unpublished', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.pragma('foreign_keys = ON');
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 13) });
      const old = new ResearchRepository(legacy);
      const project = old.createProject({ title: 'Legacy owned', description: '', workspacePath: '/workspace' });
      const created = old.experiments.create({ projectId: project.id, ...experimentRequest({ requestId: 'legacy' }) }, '/workspace', '/workspace', '/managed-runs');
      applyResearchDatabaseSchema(legacy); applyResearchDatabaseSchema(legacy);
      expect(old.experiments.get(project.id, created.id).ownerRunId).toBeNull();
      expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_workspace_files'").get()).toEqual({ name: 'research_workspace_files' });
    } finally { legacy.close(); }
  });
});
