import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { researchExperimentFileRequestSchema, researchExperimentStartSchema, type ResearchExperimentExecution, type ResearchExperimentFile,
  type ResearchExperimentRuntime, type ResearchExperimentStart } from '../../../shared/schemas/research-experiments';
import type { RocPluginContext } from '../../kernel/types';
import { ResearchExperimentEnvironmentService, type PreparedExperimentEnvironment } from './experiment-environment';
import { collectExperimentFiles, experimentFileLimit, experimentStorage, snapshotExperimentInputs } from './experiment-files';
import { juliaExperimentFlags, rExperimentCommand } from './experiment-native-probes';
import { runRExperimentProcess } from './experiment-native-process';
import { figureRenderer, figureRendererPath, validateFigureOutput } from './figure-runner';
import { indexText } from './index-files';
import { ResearchProcessError, runResearchProcess, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { writeFrozenManifest } from './research-frozen-manifest';
import { ResearchJobSession, type ResearchJobTask } from './research-job-session';
import { createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace } from './research-files';
import type { ResearchRepository } from './repository';

type FileRequest = z.infer<typeof researchExperimentFileRequestSchema>;

export class ResearchExperimentService {
  private readonly session = new ResearchJobSession('research_experiment_closed');
  private readonly executions = new Map<string, ResearchJobTask & { projectId: string }>();

  constructor(private readonly repository: ResearchRepository, private readonly environments: Pick<ResearchExperimentEnvironmentService, 'inspect'>,
    private readonly rootPath: string | null, private readonly logger: RocPluginContext['logger'],
    private readonly run: (input: ResearchProcessRequest) => Promise<ResearchProcessResult> = runResearchProcess) {}

  recover(): void { this.repository.experiments.recover(); }

  async inspect(projectId: string, runtime: ResearchExperimentRuntime): Promise<PreparedExperimentEnvironment['snapshot']> {
    return await this.session.run(async (signal) => {
      const workspace = await researchWorkspace(this.repository.getProject(projectId).workspacePath);
      const storage = await experimentStorage(this.rootPath);
      const job = await mkdtemp(join(storage, '.environment-'));
      try { return (await this.environments.inspect(workspace, runtime, job, signal)).snapshot; }
      finally { await rm(job, { recursive: true, force: true }); }
    });
  }

  async start(input: ResearchExperimentStart): Promise<ResearchExperimentExecution> {
    const request = researchExperimentStartSchema.parse(input);
    return await this.session.run(async (signal) => {
      const project = this.repository.getProject(request.projectId);
      if (project.status === 'archived') throw new Error('research_project_archived');
      const workspace = await researchWorkspace(project.workspacePath);
      const storage = await experimentStorage(this.rootPath);
      signal.throwIfAborted();
      if (project.workspacePath === null) throw new Error('research_project_workspace_required');
      const run = this.repository.experiments.create(request, project.workspacePath, workspace, storage);
      if (run.status === 'preparing' && !this.executions.has(run.id)) this.schedule(run);
      return run;
    });
  }

  abort(id: string): void { this.executions.get(id)?.controller.abort(); }

  async cancel(projectId: string, id: string): Promise<ResearchExperimentExecution> {
    this.session.requireOpen();
    const run = this.repository.experiments.get(projectId, id);
    if (!['preparing', 'running'].includes(run.status)) return run;
    const task = this.executions.get(id);
    if (task !== undefined) {
      task.controller.abort();
      await task.promise;
      return this.repository.experiments.get(projectId, id);
    }
    return this.repository.experiments.finish(projectId, id, { status: 'cancelled', files: run.files, exitCode: null, error: 'research_experiment_cancelled' });
  }

  projectChanged(projectId: string): void {
    const project = this.repository.getProject(projectId);
    for (const [id, task] of this.executions) {
      if (task.projectId !== projectId) continue;
      const run = this.repository.experiments.get(projectId, id);
      if (project.status === 'archived' || project.workspacePath !== run.workspacePath) task.controller.abort();
    }
  }

  async source(input: FileRequest): Promise<{ bytes: Buffer; file: ResearchExperimentFile }> {
    const run = this.repository.experiments.get(input.projectId, input.runId);
    const file = run.files.find((entry) => entry.area === input.area && entry.path === input.path);
    if (file === undefined) throw new Error('research_experiment_file_not_found');
    const bytes = await readResearchFile(this.repository.experiments.root(run.projectId, run.id), `${file.area}/${file.path}`, experimentFileLimit);
    if (bytes.length !== file.size || researchContentHash(bytes) !== file.sha256) throw new Error('research_experiment_snapshot_changed');
    return { bytes, file };
  }

  async read(input: FileRequest): Promise<{ file: ResearchExperimentFile; content: string; encoding: 'utf8' | 'base64' }> {
    const run = this.repository.experiments.get(input.projectId, input.runId);
    const file = run.files.find((entry) => entry.area === input.area && entry.path === input.path);
    if (file !== undefined && file.size > 4 * 1024 * 1024) throw new Error('research_experiment_preview_limit');
    const { bytes, file: record } = await this.source(input);
    try { return { file: record, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' }; }
    catch { return { file: record, content: bytes.toString('base64'), encoding: 'base64' }; }
  }

  async snapshot(projectId: string, runId: string): Promise<ResearchExperimentExecution> {
    return await this.session.run(async (signal) => {
      const run = this.repository.experiments.get(projectId, runId);
      if (run.status !== 'completed') throw new Error('research_experiment_completed_required');
      for (const file of run.files) { signal.throwIfAborted(); await this.source({ projectId, runId, area: file.area, path: file.path }); }
      const { artifactId: _artifactId, ...manifest } = run;
      await writeFrozenManifest({
        root: this.repository.experiments.root(projectId, runId),
        path: 'manifest.json',
        content: JSON.stringify(manifest, null, 2),
        limit: experimentFileLimit,
        changedCode: 'research_experiment_manifest_changed'
      });
      signal.throwIfAborted();
      return run;
    });
  }

  async publish(projectId: string, runId: string): Promise<ResearchExperimentExecution> {
    await this.snapshot(projectId, runId);
    this.session.requireOpen();
    return this.repository.experiments.publish(projectId, runId);
  }

  evidenceSource(projectId: string, evidenceId: string): FileRequest | null {
    const metadata = this.repository.evidence.sourceMetadata(projectId, evidenceId);
    if (metadata?.type !== 'experiment-run') return null;
    const value = z.object({ type: z.literal('experiment-run'), runId: z.string(), area: researchExperimentFileRequestSchema.shape.area,
      path: researchExperimentFileRequestSchema.shape.path, sha256: z.string() }).strict().parse(metadata);
    const run = this.repository.experiments.get(projectId, value.runId);
    if (!run.files.some((file) => file.area === value.area && file.path === value.path && file.sha256 === value.sha256)) throw new Error('research_experiment_snapshot_changed');
    return { projectId, runId: run.id, area: value.area, path: value.path };
  }

  async shutdown(): Promise<void> {
    await this.session.shutdown();
  }

  private schedule(run: ResearchExperimentExecution): void {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.execute(run, controller.signal));
    const task = { controller, promise, projectId: run.projectId };
    this.session.track(task);
    this.executions.set(run.id, task);
    void promise.catch((error: unknown) => this.logger.error('Research experiment could not persist its final state.', { runId: run.id, error: errorCode(error) }))
      .finally(() => { this.session.untrack(task); this.executions.delete(run.id); });
  }

  private async execute(initial: ResearchExperimentExecution, signal: AbortSignal): Promise<void> {
    const root = this.repository.experiments.root(initial.projectId, initial.id);
    let files: ResearchExperimentFile[] = [];
    let output: ResearchProcessResult = { exitCode: 1, stdout: '', stderr: '' };
    let failure: unknown;
    let prepared: PreparedExperimentEnvironment | null = null;
    try {
      const workspace = await this.verifyProject(initial, signal);
      await mkdir(root, { mode: 0o700 });
      const input = await createResearchDirectory(root, 'input');
      const out = await createResearchDirectory(root, 'output');
      const scratch = await createResearchDirectory(root, 'scratch');
      await createResearchDirectory(root, 'log');
      prepared = await this.environments.inspect(workspace, initial.request.runtime, scratch, signal);
      if (prepared.snapshot.hash !== initial.request.expectedEnvironmentHash) throw new Error('research_experiment_environment_changed');
      if (initial.request.engine === 'matplotlib' && !prepared.snapshot.packages.some((entry) => entry.name.toLowerCase() === 'matplotlib')) throw new Error('research_figure_matplotlib_required');
      const snapshot = await snapshotExperimentInputs(workspace, input, initial.request, prepared.snapshot, signal,
        initial.request.engine === 'matplotlib' ? { [figureRendererPath]: figureRenderer } : {});
      files = snapshot.files;
      await this.verifyProject(initial, signal);
      this.repository.experiments.start(initial.projectId, initial.id, prepared.snapshot, files, snapshot.hash);
      output = await this.executeProcess(initial, prepared, input, out, scratch, signal);
      if (output.exitCode !== 0) throw new Error('research_experiment_process_failed');
      if (initial.request.engine === 'matplotlib') {
        if (initial.request.figure === undefined) throw new Error('research_figure_options_invalid');
        await validateFigureOutput(out, initial.request.figure, signal);
      }
      await this.verifyProject(initial, signal);
      const current = await this.environments.inspect(workspace, initial.request.runtime, scratch, signal);
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
      if (prepared !== null) {
        files.push(...await collectExperimentFiles(join(root, 'output'), 'output'));
      }
      const status = signal.aborted ? this.session.isClosed ? 'interrupted' : 'cancelled' : failure === undefined ? 'completed' : 'failed';
      const error = signal.aborted ? this.session.isClosed ? 'research_experiment_interrupted' : 'research_experiment_cancelled' : failure === undefined ? null : errorCode(failure);
      const documents = status === 'completed' ? await this.indexDocuments(initial, files) : [];
      if (status === 'completed') await this.verifyProject(initial, signal);
      this.repository.experiments.finish(initial.projectId, initial.id, { status, files, exitCode: prepared === null ? null : output.exitCode, error }, documents);
    } catch (error) {
      this.repository.experiments.finish(initial.projectId, initial.id, { status: signal.aborted ? this.session.isClosed ? 'interrupted' : 'cancelled' : 'failed',
        files, exitCode: output.exitCode, error: errorCode(error) });
    } finally {
      await rm(join(root, 'scratch'), { recursive: true, force: true });
    }
  }

  private async executeProcess(run: ResearchExperimentExecution, prepared: PreparedExperimentEnvironment, input: string, output: string, scratch: string, signal: AbortSignal): Promise<ResearchProcessResult> {
    const request = run.request;
    const executable = prepared.snapshot.executable;
    const environment = { ...prepared.environment, PYTHONUNBUFFERED: '1', PATH: `${dirname(executable)}:${prepared.environment.PATH}`, ROC_INPUT_DIR: input, ROC_OUTPUT_DIR: output,
      ROC_PARAMETERS_JSON: JSON.stringify(request.parameters),
      ...(request.engine === 'matplotlib' ? { SOURCE_DATE_EPOCH: '0', PYTHONHASHSEED: '0' } : {}) };
    const source = join(input, request.sourcePath);
    const command = request.engine === 'r' ? rExperimentCommand(prepared.snapshot.basePrefix, executable, ['--vanilla', '--slave', '-f', source, '--args', ...request.arguments])
      : request.engine === 'julia' ? { command: executable, args: [...juliaExperimentFlags, `--project=${input}`, '--', source, ...request.arguments] }
      : request.engine === 'matplotlib' ? { command: executable, args: ['-B', '-s', join(input, figureRendererPath), 'render', source, output, JSON.stringify(request.figure), ...request.arguments] }
      : { command: executable, args: ['-B', '-s', source, ...request.arguments] };
    const processRequest: ResearchProcessRequest = { ...command,
      additionalExecutables: [executable], cwd: input, readablePaths: [...prepared.readablePaths, input],
      writablePaths: [output, scratch], environment,
      timeoutMs: request.timeoutMs, signal, allowOcrAcceleration: false, allowPosixSpawn: false, networkAccess: request.network === 'enabled' ? 'full' : 'none' };
    return request.engine === 'r' ? await runRExperimentProcess(processRequest, this.run) : await this.run(processRequest);
  }

  private async indexDocuments(run: ResearchExperimentExecution, files: ResearchExperimentFile[]) {
    const documents = [];
    for (const file of files) {
      if (file.area === 'input' || file.size === 0) continue;
      if (file.size > 4 * 1024 * 1024 || file.area !== 'log' && !['.txt', '.md', '.csv', '.json', '.tsv'].includes(extname(file.path).toLowerCase())) continue;
      const bytes = await readResearchFile(this.repository.experiments.root(run.projectId, run.id), `${file.area}/${file.path}`, experimentFileLimit);
      if (researchContentHash(bytes) !== file.sha256) throw new Error('research_experiment_snapshot_changed');
      const parsed = indexText(bytes);
      if (parsed.chunks.length === 0) continue;
      documents.push({ id: `experiment:${run.id}:${file.area}:${file.path}`, title: `${run.request.label}: ${file.path}`, content: parsed.content,
        chunks: parsed.chunks.map((chunk) => ({ ...chunk, locator: `${file.area}/${file.path}; ${chunk.locator}` })),
        metadata: { type: 'experiment-run', runId: run.id, area: file.area, path: file.path, sha256: file.sha256 } });
    }
    return documents;
  }

  private async verifyProject(run: ResearchExperimentExecution, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.repository.experiments.requireActive(run.projectId, run.id);
    const project = this.repository.getProject(run.projectId);
    if (project.workspacePath !== run.workspacePath) throw new Error('research_experiment_workspace_changed');
    const root = await researchWorkspace(run.workspacePath);
    signal.throwIfAborted();
    this.repository.experiments.requireActive(run.projectId, run.id);
    if (root !== run.workspaceRoot) throw new Error('research_experiment_workspace_changed');
    return root;
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^research_[a-z0-9_]+$/u.test(error.message) ? error.message : 'research_experiment_failed';
}

