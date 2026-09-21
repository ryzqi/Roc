import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { ResearchExperimentService } from '../../../../src/main/plugins/research/experiment-service';
import type { PreparedExperimentEnvironment } from '../../../../src/main/plugins/research/experiment-environment';
import { ResearchExportService } from '../../../../src/main/plugins/research/export-service';
import { ResearchFigureService } from '../../../../src/main/plugins/research/figure-service';
import { figureManifestPath } from '../../../../src/main/plugins/research/figure-repository';
import { figureRenderer, figureRendererPath, figureValidationPath } from '../../../../src/main/plugins/research/figure-runner';
import { ResearchProductionEffectService } from '../../../../src/main/plugins/research/production-effects';
import { createResearchProductionJob } from '../../../../src/main/plugins/research/research-production-job';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { getResearchStageRoleProfile, researchCapabilityToolNames } from '../../../../src/main/plugins/research/role-profiles';
import { createResearchRoleTools } from '../../../../src/main/plugins/research/role-tools';
import { createResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { ResearchStageRuntime } from '../../../../src/main/plugins/research/stage-runtime';
import { ResearchTemplateService } from '../../../../src/main/plugins/research/template-service';
import { ResearchWorkspaceFileService } from '../../../../src/main/plugins/research/workspace-files';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import type { ResearchRoleExecution } from '../../../../src/main/plugins/research/role-executor';
import type { ResearchScriptExperimentStart } from '../../../../src/shared/schemas/research-experiments';
import type { ResearchFigureValidation } from '../../../../src/shared/schemas/research-plotting';
import type { ResearchStageOutput } from '../../../../src/shared/types';
import { approveExportManuscript } from './export-test-helpers';

let db: Database.Database;
let repository: ResearchRepository;
let experiments: ResearchExperimentService;
let figures: ResearchFigureService;
let templates: ResearchTemplateService;
let exports: ResearchExportService;
let effects: ResearchProductionEffectService;
let files: ResearchWorkspaceFileService;
let runtime: ResearchStageRuntime | undefined;
let root: string;
let workspace: string;
let projectId: string;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const inspect = vi.fn(async (): Promise<PreparedExperimentEnvironment> => environment);
const environment: PreparedExperimentEnvironment = {
  snapshot: { runtime: { kind: 'bundled-python' }, executable: '/python/bin/python', prefix: '/python', basePrefix: '/python', version: '3.12.14',
    platform: 'darwin', architecture: 'arm64', toolchainHash: 'a'.repeat(64), metadataHash: 'a'.repeat(64), packages: [{ name: 'matplotlib', version: '3.11.1' }], lockFiles: [], hash: 'b'.repeat(64) },
  readablePaths: ['/python'], environment: { PATH: '/python/bin:/usr/bin' }, python: '/python/bin/python'
};
const options = { widthInches: 4, heightInches: 3, dpi: 150, seed: 42 };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-role-results-')));
  workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'run.py'), 'print("source v1")');
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Role results', description: 'Bind real production outputs.', workspacePath: workspace }).id;
  inspect.mockReset().mockResolvedValue(environment);
  experiments = new ResearchExperimentService(repository, { inspect }, join(root, 'runs'), logger, async (input) => {
    const directory = input.environment.ROC_OUTPUT_DIR;
    if (directory === undefined) throw new Error('output_directory_required');
    await writeFile(join(directory, 'result.csv'), 'measurement\n42\n');
    return { exitCode: 0, stdout: 'Measured signal 42.\n', stderr: '' };
  });
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
afterEach(async () => {
  await runtime?.shutdown();
  await Promise.all([exports.shutdown(), figures.shutdown(), experiments.shutdown(), templates.shutdown()]);
  db.close();
  await rm(root, { recursive: true, force: true });
});

const notes: ResearchStageOutput = { title: 'Measured results', markdown: 'Published the recorded run.', claims: [], sections: [], verdict: 'ready' };

function enter(stage: 'experiment' | 'figure' | 'export'): void {
  if (repository.getWorkflow(projectId).currentStage !== stage) {
    repository.transitionWorkflow({ projectId, expectedStage: repository.getWorkflow(projectId).currentStage, action: 'move', targetStage: stage });
  }
}

function experimentRequest(input: Partial<ResearchScriptExperimentStart> = {}): Omit<ResearchScriptExperimentStart, 'projectId' | 'ownerRunId'> {
  return { requestId: randomUUID(), label: 'Signal experiment', engine: 'python', runtime: { kind: 'bundled-python' }, sourcePath: 'run.py',
    inputPaths: [], arguments: [], parameters: {}, expectedEnvironmentHash: environment.snapshot.hash, timeoutMs: 10000, network: 'disabled', ...input };
}

function createRuntime(execute: (input: ResearchRoleExecution) => Promise<{ output: unknown; modelVersion: string | null }>) {
  const production = createResearchProductionJob({ repository, experiments, figures, exports });
  runtime = new ResearchStageRuntime(repository, new CapabilityRegistry(), {
    prepare: async () => ({ providerId: 'test-provider', modelId: 'test-model', execute })
  }, createResearchHumanGate({ repository, production }), effects);
  return runtime;
}

function captureEvidence(content = 'Measured signal 42.') {
  const documentId = randomUUID();
  repository.knowledge.upsertKnowledgeDocument({ id: documentId, projectId, sourceType: 'file', sourceId: 'data.csv', title: 'Measurements',
    content, chunks: [{ content, locator: 'row 2' }], embeddingConfigId: null });
  return repository.evidence.capture({ projectId, chunkId: `${documentId}:chunk:0` });
}

async function completedFigureRun(ownerRunId: string) {
  const request = { projectId, ownerRunId, requestId: randomUUID(), label: 'Measured response', engine: 'matplotlib' as const, runtime: { kind: 'bundled-python' as const },
    sourcePath: 'plot.py', inputPaths: ['data.csv'], arguments: [], parameters: {}, expectedEnvironmentHash: environment.snapshot.hash,
    timeoutMs: 10000, network: 'disabled' as const, figure: options };
  const initial = repository.experiments.create(request, workspace, workspace, join(root, 'runs'));
  const entries: Array<{ area: 'input' | 'output'; path: string; content: string }> = [
    { area: 'input', path: 'plot.py', content: 'figure = build_figure()' }, { area: 'input', path: 'data.csv', content: 'value\n42\n' },
    { area: 'input', path: figureRendererPath, content: figureRenderer },
    ...(['png', 'svg', 'pdf'] as const).map((format) => ({ area: 'output' as const, path: `figure.${format}`, content: `${format} unit fixture` }))
  ];
  const file = (entry: typeof entries[number]) => ({ area: entry.area, path: entry.path, sha256: researchContentHash(entry.content), size: Buffer.byteLength(entry.content) });
  const validation: ResearchFigureValidation = { options, rendererHash: researchContentHash(figureRenderer), widthPixels: 600, heightPixels: 450, widthPoints: 288, heightPoints: 216, pageCount: 1,
    files: (['png', 'svg', 'pdf'] as const).map((format) => ({ path: `figure.${format}`, sha256: researchContentHash(`${format} unit fixture`), size: Buffer.byteLength(`${format} unit fixture`) })) };
  entries.push({ area: 'output', path: figureValidationPath, content: JSON.stringify(validation) });
  const runRoot = repository.experiments.root(projectId, initial.id);
  for (const entry of entries) {
    const destination = join(runRoot, entry.area, entry.path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, entry.content);
  }
  repository.experiments.start(projectId, initial.id, environment.snapshot, entries.filter((entry) => entry.area === 'input').map(file), researchContentHash('fixture inputs'));
  return repository.experiments.finish(projectId, initial.id, { status: 'completed', files: entries.map(file), exitCode: 0, error: null });
}

describe('production role results', () => {
  it('fails an experiment stage without a published run and does not invent an empty artifact', async () => {
    enter('experiment');
    const engine = createRuntime(async () => ({ output: notes, modelVersion: 'experiment-model-v1' }));
    const run = engine.start({ projectId, expectedStage: 'experiment', instruction: 'Run the measurement.', requestId: 'no-publish' });
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, projectId)).toMatchObject({
      status: 'failed', error: 'research_stage_production_required', outputArtifactIds: [], modelVersion: 'experiment-model-v1'
    });
    expect(repository.listArtifacts(projectId, 'experiment')).toEqual([]);
    expect(repository.getWorkflow(projectId).stages.find((stage) => stage.stage === 'experiment')?.status).toBe('failed');
  });

  it('binds a published experiment, records model provenance and keeps the real file path', async () => {
    enter('experiment');
    const engine = createRuntime(async (input) => {
      expect(input.tools.map((tool) => tool.name)).not.toContain('approve_stage');
      expect(input.tools.map((tool) => tool.name)).not.toContain('write_export');
      const start = input.tools.find((tool) => tool.name === 'start_experiment');
      const publish = input.tools.find((tool) => tool.name === 'publish_experiment');
      const started = await start?.invoke(experimentRequest({ requestId: 'owned-result' }));
      await vi.waitFor(() => expect(repository.experiments.get(projectId, started.experimentId).status).toBe('completed'), { timeout: 5000 });
      const published = await publish?.invoke({ experimentId: started.experimentId });
      expect(published.artifactId).not.toBeNull();
      expect(() => repository.updateArtifact({ id: published.artifactId, path: '/forged.json' })).toThrow('research_experiment_publication_immutable');
      return { output: notes, modelVersion: 'experiment-model-v2' };
    });
    const run = engine.start({ projectId, expectedStage: 'experiment', instruction: 'Publish the measurement.', requestId: 'publish-result' });
    await engine.waitForIdle();
    const completed = repository.runs.get(run.id, projectId);
    expect(completed).toMatchObject({ status: 'completed', modelVersion: 'experiment-model-v2', outputArtifactIds: [expect.any(String)] });
    const artifact = repository.getArtifact(completed.outputArtifactIds[0]);
    expect(artifact).toMatchObject({ kind: 'experiment_run', status: 'draft', path: join(root, 'runs', repository.experiments.forArtifact(artifact).id, 'manifest.json') });
    expect(repository.experiments.forArtifact(artifact).ownerRunId).toBe(run.id);
    expect(repository.runs.getArtifactContent(projectId, artifact.id)?.output).toEqual(notes);
    expect(repository.listProvenance({ projectId, subjectId: artifact.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'experiment', sourceId: repository.experiments.forArtifact(artifact).id }),
      expect.objectContaining({ sourceType: 'model_run', sourceId: run.id, locator: 'provider:test-provider; model:test-model; version:experiment-model-v2' })
    ]));
    expect(repository.getWorkflow(projectId).stages.find((stage) => stage.stage === 'experiment')?.status).toBe('waiting_approval');
  });

  it('keeps a published experiment after failure and rebinds it on retry', async () => {
    enter('experiment');
    const engine = createRuntime(async (input) => {
      if (input.run.retryOfRunId === null) {
        const started = await input.tools.find((tool) => tool.name === 'start_experiment')?.invoke(experimentRequest({ requestId: 'owned-once' }));
        await vi.waitFor(() => expect(repository.experiments.get(projectId, started.experimentId).status).toBe('completed'), { timeout: 5000 });
        await input.tools.find((tool) => tool.name === 'publish_experiment')?.invoke({ experimentId: started.experimentId });
        throw new Error('research_test_failure');
      }
      return { output: { ...notes, title: 'Retried results' }, modelVersion: 'retry-model' };
    });
    const run = engine.start({ projectId, expectedStage: 'experiment', instruction: 'Retry after publish.', requestId: 'first-fail' });
    await engine.waitForIdle();
    const published = repository.listArtifacts(projectId, 'experiment');
    expect(repository.runs.get(run.id, projectId)).toMatchObject({ status: 'failed', error: 'research_test_failure', outputArtifactIds: [] });
    expect(published).toHaveLength(1);
    expect(published[0].path).toContain('manifest.json');
    const retry = engine.retry({ projectId, runId: run.id, requestId: 'second-try' });
    await engine.waitForIdle();
    const completed = repository.runs.get(retry.id, projectId);
    expect(completed.status).toBe('completed');
    expect(completed).toMatchObject({ status: 'completed', outputArtifactIds: [published[0].id], modelVersion: 'retry-model' });
    expect(repository.listArtifacts(projectId, 'experiment').map((artifact) => artifact.id)).toEqual([published[0].id]);
    expect(repository.runs.getArtifactContent(projectId, published[0].id)?.runId).toBe(retry.id);
  });

  it('rejects a foreign published experiment and binds only this run lineage', async () => {
    enter('experiment');
    const foreign = repository.runs.markRunning(
      repository.runs.begin({ projectId, expectedStage: 'experiment', instruction: 'Other run.', requestId: 'foreign-owner' }).id,
      projectId, { providerId: 'test-provider', modelId: 'test-model' }
    );
    const started = await effects.startExperiment(foreign.id, projectId, experimentRequest({ requestId: 'foreign-experiment' }));
    await vi.waitFor(() => expect(repository.experiments.get(projectId, started.id).status).toBe('completed'), { timeout: 5000 });
    const published = await effects.publishExperiment(foreign.id, projectId, started.id);
    repository.runs.terminate(foreign.id, projectId, 'cancelled', 'research_run_cancelled');
    const engine = createRuntime(async () => ({ output: notes, modelVersion: null }));
    const run = engine.start({ projectId, expectedStage: 'experiment', instruction: 'Ignore foreign work.', requestId: 'current-owner' });
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, projectId)).toMatchObject({ status: 'failed', error: 'research_stage_production_required' });
    expect(repository.getArtifact(published.artifactId!).path).toContain('manifest.json');
    expect(repository.runs.getArtifactContent(projectId, published.artifactId!)).toBeNull();
  });

  it('binds a published figure, records model provenance and does not expose approval tools', async () => {
    enter('figure');
    const evidence = captureEvidence();
    let plotId = '';
    const engine = createRuntime(async (input) => {
      expect(getResearchStageRoleProfile('figure').allowedCapabilities).not.toContain('research.workflow.transition');
      expect(input.tools.map((tool) => tool.name)).not.toContain('write_export');
      const plot = await completedFigureRun(input.run.id);
      plotId = plot.id;
      const published = await input.tools.find((tool) => tool.name === 'publish_figure')?.invoke({ experimentId: plot.id, replacesFigureId: null });
      expect(published.artifactId).not.toBeNull();
      return { output: { title: 'Measured response', markdown: 'Rendered the recorded figure.', verdict: 'ready',
        claims: [{ subjectType: 'figure', content: 'Measured signal 42.', status: 'supported', evidenceIds: [evidence.id] }],
        sections: [] }, modelVersion: 'figure-model-v1' };
    });
    const run = engine.start({ projectId, expectedStage: 'figure', instruction: 'Publish the figure.', requestId: 'figure-result' });
    await engine.waitForIdle();
    const completed = repository.runs.get(run.id, projectId);
    expect(completed).toMatchObject({ status: 'completed', modelVersion: 'figure-model-v1' });
    const artifact = repository.getArtifact(completed.outputArtifactIds[0]);
    const figure = repository.figures.forArtifact(artifact);
    expect(artifact.path).toBe(join(repository.experiments.root(projectId, plotId), figureManifestPath));
    expect(repository.listProvenance({ projectId, subjectId: artifact.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'experiment', sourceId: plotId }),
      expect.objectContaining({ sourceType: 'model_run', sourceId: run.id, locator: 'provider:test-provider; model:test-model; version:figure-model-v1' })
    ]));
    expect(repository.evidence.listClaims({ projectId, artifactId: artifact.id })).toMatchObject([{ subjectType: 'figure', evidenceIds: [evidence.id] }]);
    expect(repository.getWorkflow(projectId).stages.find((stage) => stage.stage === 'figure')?.status).toBe('waiting_approval');
    expect(figure.status).toBe('rendered');
  });

  it('keeps a completed figure run from advancing when snapshot verification fails', async () => {
    enter('figure');
    const evidence = captureEvidence();
    vi.spyOn(figures, 'verifyStage').mockRejectedValue(new Error('research_figure_manifest_changed'));
    const engine = createRuntime(async (input) => {
      const plot = await completedFigureRun(input.run.id);
      await input.tools.find((tool) => tool.name === 'publish_figure')?.invoke({ experimentId: plot.id, replacesFigureId: null });
      return { output: { title: 'Measured response', markdown: 'Rendered the recorded figure.', verdict: 'ready',
        claims: [{ subjectType: 'figure', content: 'Measured signal 42.', status: 'supported', evidenceIds: [evidence.id] }],
        sections: [] }, modelVersion: 'figure-model-stale' };
    });
    const run = engine.start({ projectId, expectedStage: 'figure', instruction: 'Publish the figure.', requestId: 'figure-stale' });
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, projectId)).toMatchObject({ status: 'completed', modelVersion: 'figure-model-stale' });
    const stage = repository.getWorkflow(projectId).stages.find((entry) => entry.stage === 'figure');
    expect(stage).toMatchObject({ status: 'running', activeRunId: null });
    expect(repository.listArtifacts(projectId, 'figure')).toHaveLength(1);
    expect(figures.verifyStage).toHaveBeenCalledWith(projectId);
    expect(() => engine.start({ projectId, expectedStage: 'figure', instruction: 'Publish the figure again.', requestId: 'figure-stale-2' }))
      .toThrow('research_stage_awaiting_gate');
    expect(() => engine.retry({ projectId, runId: run.id, requestId: 'figure-stale-retry' })).toThrow('research_run_not_retryable');
  });

  it('fails an export stage without a published package and does not invent an empty artifact', async () => {
    await approveExportManuscript(repository, projectId);
    const engine = createRuntime(async () => ({
      output: { title: 'Delivery', markdown: 'Prepared nothing.', claims: [], sections: [], verdict: 'ready' }, modelVersion: 'export-model'
    }));
    const run = engine.start({ projectId, expectedStage: 'export', instruction: 'Export the package.', requestId: 'export-none' });
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, projectId)).toMatchObject({
      status: 'failed', error: 'research_stage_production_required', outputArtifactIds: [], modelVersion: 'export-model'
    });
    expect(repository.listArtifacts(projectId, 'export')).toEqual([]);
  });

  it('does not expose final delivery or human approval tools on export roles', () => {
    const profile = getResearchStageRoleProfile('export');
    expect(profile.allowedCapabilities).toEqual(expect.arrayContaining([
      'research.export.prepareOwned', 'research.export.getOwned', 'research.export.publishOwned'
    ]));
    expect(profile.allowedCapabilities).not.toEqual(expect.arrayContaining([
      'research.export.write', 'research.workflow.transition'
    ]));
    const queued = repository.runs.begin({ projectId, expectedStage: 'discovery', instruction: 'Search.', requestId: randomUUID() });
    const run = repository.runs.markRunning(queued.id, projectId, { providerId: 'test-provider', modelId: 'test-model' });
    const tools = createResearchRoleTools({
      run: { ...run, stage: 'export', outputKind: profile.outputKind, toolNames: profile.allowedCapabilities.map((capability) => {
        const name = researchCapabilityToolNames[capability];
        if (name === undefined) throw new Error(`tool_required:${capability}`);
        return name;
      }) },
      context: repository.runs.getContext(run.id), repository, capabilities: new CapabilityRegistry(),
      signal: new AbortController().signal, effects
    });
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['prepare_export', 'get_export', 'publish_export']));
    expect(tools.map((tool) => tool.name)).not.toContain('write_export');
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['approve_stage', 'transition_workflow']));
  });
});
