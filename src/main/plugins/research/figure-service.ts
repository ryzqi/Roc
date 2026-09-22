import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import { researchExperimentFileRequestSchema, type ResearchExperimentFile } from '../../../shared/schemas/research-experiments';
import { researchFigureStartSchema, type ResearchFigurePublication, type ResearchFigureRun, type ResearchFigureStart, researchFigureSourceRequestSchema } from '../../../shared/schemas/research-figures';
import { researchFigureValidationSchema } from '../../../shared/schemas/research-plotting';
import { collectExperimentFiles, experimentFileLimit, experimentStorage, snapshotExperimentInputs } from './experiment-files';
import type { ResearchExperimentService } from './experiment-service';
import { assertFigureRun, figureManifest, figureManifestPath } from './figure-repository';
import { assertFigureEnvironment, figureGeneratedInputs, figureProcessCommand, figureValidationPath, finishFigureOutput } from './figure-runner';
import { ResearchProcessError } from './process-runner';
import { writeFrozenManifest } from './research-frozen-manifest';
import { ResearchBackgroundJobs, ResearchJobSession } from './research-job-session';
import { createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace } from './research-files';
import type { ResearchRepository } from './repository';
import type { RocPluginContext } from '../../kernel/types';

type FileRequest = z.infer<typeof researchExperimentFileRequestSchema>;

export class ResearchFigureService {
  private readonly session = new ResearchJobSession('research_figure_service_closed');
  private readonly executions = new ResearchBackgroundJobs<{ projectId: string }>(this.session, (runId, error) => {
    this.logger.error('Research figure could not persist its final state.', { runId, error: errorCode(error) });
  });

  constructor(
    private readonly repository: ResearchRepository,
    private readonly experiments: ResearchExperimentService,
    private readonly rootPath: string | null,
    private readonly logger: RocPluginContext['logger']
  ) {}

  recover(): void { this.repository.figureRuns.recover(); }

  async inspect(projectId: string, runtime: ResearchFigureStart['runtime']) {
    return this.experiments.inspect(projectId, runtime);
  }

  async start(input: ResearchFigureStart): Promise<ResearchFigureRun> {
    const request = researchFigureStartSchema.parse(input);
    return await this.session.run(async (signal) => {
      const project = this.repository.getProject(request.projectId);
      if (project.status === 'archived') throw new Error('research_project_archived');
      const workspace = await researchWorkspace(project.workspacePath);
      const storage = await experimentStorage(this.rootPath);
      signal.throwIfAborted();
      if (project.workspacePath === null) throw new Error('research_project_workspace_required');
      const run = this.repository.figureRuns.create(request, project.workspacePath, workspace, storage);
      if (run.status === 'preparing' && !this.executions.has(run.id)) {
        this.executions.start(run.id, { projectId: run.projectId }, (jobSignal) => this.execute(run, jobSignal));
      }
      return run;
    });
  }

  async cancel(projectId: string, runId: string): Promise<ResearchFigureRun> {
    this.session.requireOpen();
    const run = this.repository.figureRuns.get(projectId, runId);
    if (!['preparing', 'running'].includes(run.status)) return run;
    const task = this.executions.get(runId);
    if (task !== undefined) {
      this.executions.abort(runId);
      await this.executions.wait(runId);
      return this.repository.figureRuns.get(projectId, runId);
    }
    return this.repository.figureRuns.finish(projectId, runId, { status: 'cancelled', files: run.files, exitCode: null, error: 'research_figure_cancelled' });
  }

  getRun(projectId: string, runId: string): ResearchFigureRun {
    return this.repository.figureRuns.get(projectId, runId);
  }

  list(projectId: string, limit: number): ResearchFigureRun[] {
    return this.repository.figureRuns.list(projectId, limit);
  }

  abort(id: string): void { this.executions.abort(id); }

  projectChanged(projectId: string): void {
    const project = this.repository.getProject(projectId);
    this.executions.abortMatching((id, task) => {
      if (task.projectId !== projectId) return false;
      const run = this.repository.figureRuns.get(projectId, id);
      return project.status === 'archived' || project.workspacePath !== run.workspacePath;
    });
  }

  async read(input: FileRequest) {
    const run = this.repository.figureRuns.get(input.projectId, input.runId);
    const file = run.files.find((entry) => entry.area === input.area && entry.path === input.path);
    if (file !== undefined && file.size > 4 * 1024 * 1024) throw new Error('research_figure_preview_limit');
    const { bytes, file: record } = await this.readRunFile(input);
    try { return { file: record, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' as const }; }
    catch { return { file: record, content: bytes.toString('base64'), encoding: 'base64' as const }; }
  }

  async publish(projectId: string, runId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    return await this.session.guard(async () => this.publishRun(projectId, runId, replacesFigureId));
  }

  private async publishRun(projectId: string, runId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    this.session.requireOpen();
    const run = await this.snapshot(projectId, runId);
    const validation = await this.validation(projectId, runId);
    assertFigureRun(run, validation);
    const content = figureManifest(run, validation);
    const hash = await writeFrozenManifest({
      root: this.repository.figureRuns.root(projectId, runId),
      path: figureManifestPath,
      content,
      limit: experimentFileLimit,
      changedCode: 'research_figure_manifest_changed'
    });
    this.session.requireOpen();
    return this.repository.figures.publish(projectId, runId, replacesFigureId, validation, hash);
  }

  async verify(projectId: string, figureId: string): Promise<ResearchFigurePublication> {
    this.session.requireOpen();
    const record = this.repository.figures.get(projectId, figureId);
    const run = await this.snapshot(projectId, record.runId);
    const validation = await this.validation(projectId, record.runId);
    assertFigureRun(run, validation);
    const bytes = await readResearchFile(this.repository.figureRuns.root(projectId, record.runId), figureManifestPath, experimentFileLimit);
    if (researchContentHash(bytes) !== record.manifestHash || researchContentHash(figureManifest(run, validation)) !== record.manifestHash) throw new Error('research_figure_manifest_changed');
    return record;
  }

  async verifyStage(projectId: string): Promise<void> {
    await this.session.guard(async () => {
      const stage = this.repository.getWorkflow(projectId).stages.find((entry) => entry.stage === 'figure');
      if (stage === undefined) throw new Error('research_stage_not_found');
      for (const id of stage.artifactIds) {
        const record = this.repository.figures.forArtifact(this.repository.getArtifact(id));
        await this.verify(projectId, record.id);
      }
      this.session.requireOpen();
    });
  }

  async source(input: z.infer<typeof researchFigureSourceRequestSchema>): Promise<Buffer> {
    return this.publishedSource(input);
  }

  private async readRunFile(input: FileRequest): Promise<{ bytes: Buffer; file: ResearchExperimentFile }> {
    this.session.requireOpen();
    const run = this.repository.figureRuns.get(input.projectId, input.runId);
    const file = run.files.find((entry) => entry.area === input.area && entry.path === input.path);
    if (file === undefined) throw new Error('research_figure_file_not_found');
    const bytes = await readResearchFile(this.repository.figureRuns.root(run.projectId, run.id), `${file.area}/${file.path}`, experimentFileLimit);
    if (bytes.length !== file.size || researchContentHash(bytes) !== file.sha256) throw new Error('research_figure_snapshot_changed');
    return { bytes, file };
  }

  async shutdown(): Promise<void> { await this.session.shutdown(); }

  private async publishedSource(input: z.infer<typeof researchFigureSourceRequestSchema>): Promise<Buffer> {
    this.session.requireOpen();
    const figure = this.repository.figures.get(input.projectId, input.figureId);
    const expected = figure.validation.files.find((file) => file.path === `figure.${input.format}`);
    if (expected === undefined || expected.sha256 !== input.sha256) throw new Error('research_figure_output_changed');
    const manifest = await readResearchFile(this.repository.figureRuns.root(input.projectId, figure.runId), figureManifestPath, experimentFileLimit);
    if (researchContentHash(manifest) !== figure.manifestHash) throw new Error('research_figure_manifest_changed');
    const loaded = await this.readRunFile({ projectId: input.projectId, runId: figure.runId, area: 'output', path: expected.path });
    if (loaded.file.sha256 !== expected.sha256 || loaded.file.size !== expected.size) throw new Error('research_figure_output_changed');
    return loaded.bytes;
  }

  private async snapshot(projectId: string, runId: string): Promise<ResearchFigureRun> {
    return await this.session.run(async (signal) => {
      this.session.requireOpen();
      const run = this.repository.figureRuns.get(projectId, runId);
      this.session.requireOpen();
      if (run.status !== 'completed') throw new Error('research_figure_completed_required');
      for (const file of run.files) {
        this.session.requireOpen();
        signal.throwIfAborted();
        await this.readRunFile({ projectId, runId, area: file.area, path: file.path });
      }
      return run;
    });
  }

  private async execute(initial: ResearchFigureRun, signal: AbortSignal): Promise<void> {
    const root = this.repository.figureRuns.root(initial.projectId, initial.id);
    let files: ResearchExperimentFile[] = [];
    let output = { exitCode: 1, stdout: '', stderr: '' };
    let failure: unknown;
    let prepared: Awaited<ReturnType<ResearchExperimentService['inspectWorkspace']>> | null = null;
    try {
      const workspace = await this.verifyRun(initial, signal);
      await mkdir(root, { mode: 0o700 });
      const input = await createResearchDirectory(root, 'input');
      const out = await createResearchDirectory(root, 'output');
      const scratch = await createResearchDirectory(root, 'scratch');
      await createResearchDirectory(root, 'log');
      prepared = await this.experiments.inspectWorkspace(workspace, initial.request.runtime, scratch, signal);
      if (initial.request.expectedEnvironmentHash !== undefined && prepared.snapshot.hash !== initial.request.expectedEnvironmentHash) throw new Error('research_experiment_environment_changed');
      assertFigureEnvironment(prepared.snapshot.packages);
      const snapshot = await snapshotExperimentInputs(workspace, input, initial.request, prepared.snapshot, signal, figureGeneratedInputs());
      files = snapshot.files;
      await this.verifyRun(initial, signal);
      this.repository.figureRuns.start(initial.projectId, initial.id, prepared.snapshot, files, snapshot.hash);
      const command = figureProcessCommand(initial, prepared, input, out);
      const executable = prepared.snapshot.executable;
      output = await this.experiments.runProcess({
        command: command.command, args: command.args, additionalExecutables: [executable], cwd: input,
        readablePaths: [...prepared.readablePaths, input], writablePaths: [out, scratch],
        environment: {
          ...prepared.environment, PYTHONUNBUFFERED: '1', PATH: `${dirname(executable)}:${prepared.environment.PATH}`,
          ROC_INPUT_DIR: input, ROC_OUTPUT_DIR: out, ROC_PARAMETERS_JSON: JSON.stringify(initial.request.parameters),
          ...command.environment
        },
        timeoutMs: initial.request.timeoutMs, signal, allowOcrAcceleration: false, allowPosixSpawn: false, networkAccess: 'none'
      });
      if (output.exitCode !== 0) throw new Error('research_figure_process_failed');
      await finishFigureOutput(initial, out, signal);
      await this.verifyRun(initial, signal);
      const current = await this.experiments.inspectWorkspace(workspace, initial.request.runtime, scratch, signal);
      if (current.snapshot.hash !== prepared.snapshot.hash) throw new Error('research_experiment_environment_changed');
    } catch (error) {
      failure = error;
      if (error instanceof ResearchProcessError) output = { exitCode: 1, stdout: output.stdout + error.stdout, stderr: output.stderr + error.stderr };
    }
    try {
      await createResearchDirectory(root, 'log');
      await writeFile(join(root, 'log/stdout.txt'), output.stdout, { flag: 'wx', mode: 0o400 });
      await writeFile(join(root, 'log/stderr.txt'), output.stderr, { flag: 'wx', mode: 0o400 });
      files.push(...await collectExperimentFiles(join(root, 'log'), 'log'));
      if (prepared !== null) files.push(...await collectExperimentFiles(join(root, 'output'), 'output'));
      const status = signal.aborted ? this.session.isClosed ? 'interrupted' : 'cancelled' : failure === undefined ? 'completed' : 'failed';
      const error = signal.aborted ? this.session.isClosed ? 'research_figure_interrupted' : 'research_figure_cancelled' : failure === undefined ? null : errorCode(failure);
      this.repository.figureRuns.finish(initial.projectId, initial.id, { status, files, exitCode: prepared === null ? null : output.exitCode, error });
    } catch (error) {
      this.repository.figureRuns.finish(initial.projectId, initial.id, {
        status: signal.aborted ? this.session.isClosed ? 'interrupted' : 'cancelled' : 'failed',
        files, exitCode: output.exitCode, error: errorCode(error)
      });
    } finally {
      await rm(join(root, 'scratch'), { recursive: true, force: true });
    }
  }

  private async verifyRun(run: ResearchFigureRun, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.session.requireOpen();
    const current = this.repository.figureRuns.requireActive(run.projectId, run.id);
    if (current.workspacePath !== run.workspacePath) throw new Error('research_figure_workspace_changed');
    const workspace = await researchWorkspace(current.workspacePath);
    if (workspace !== run.workspaceRoot) throw new Error('research_figure_workspace_changed');
    return workspace;
  }

  private async validation(projectId: string, runId: string) {
    const loaded = await this.readRunFile({ projectId, runId, area: 'output', path: figureValidationPath });
    return researchFigureValidationSchema.parse(JSON.parse(loaded.bytes.toString('utf8')));
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^research_[a-z0-9_]+$/u.test(error.message) ? error.message : 'research_figure_failed';
}
