import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { researchExperimentFileRequestSchema, researchExperimentStartSchema, type ResearchExperimentExecution, type ResearchExperimentFile,
  type ResearchExperimentStartRuntime, type ResearchExperimentStart } from '../../../shared/schemas/research-experiments';
import type { RocPluginContext } from '../../kernel/types';
import { ResearchExperimentEnvironmentService, type PreparedExperimentEnvironment } from './experiment-environment';
import { collectExperimentFiles, experimentCsvRowLimit, experimentFileLimit, experimentInputTotalLimit, experimentOutputTotalLimit,
  experimentRunnerRequestLimit, experimentFileCountLimit, experimentDirectoryEntryLimit, experimentStorage, snapshotExperimentInputs } from './experiment-files';
import { juliaExperimentFlags, rExperimentCommand } from './experiment-native-probes';
import { runRExperimentProcess } from './experiment-native-process';
import { indexText } from './index-files';
import { ResearchProcessError, runResearchProcess, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { writeFrozenManifest } from './research-frozen-manifest';
import { ResearchBackgroundJobs, ResearchJobSession } from './research-job-session';
import { createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace } from './research-files';
import type { ResearchRepository } from './repository';

type FileRequest = z.infer<typeof researchExperimentFileRequestSchema>;
type ExecuteProcessInput = {
  request: ResearchExperimentStart;
  prepared: PreparedExperimentEnvironment;
  input: string;
  output: string;
  scratch: string;
  signal: AbortSignal;
};

function cancelledExecutionStatus(sessionClosed: boolean): 'interrupted' | 'cancelled' {
  return sessionClosed ? 'interrupted' : 'cancelled';
}

function cancelledExecutionError(sessionClosed: boolean): string {
  return sessionClosed ? 'research_experiment_interrupted' : 'research_experiment_cancelled';
}

export class ResearchExperimentService {
  private readonly session = new ResearchJobSession('research_experiment_closed');
  private readonly executions = new ResearchBackgroundJobs<{ projectId: string }>(this.session, (runId, error) => {
    this.logger.error('Research experiment could not persist its final state.', { runId, error: errorCode(error) });
  });

  constructor(private readonly repository: ResearchRepository, private readonly environments: Pick<ResearchExperimentEnvironmentService, 'inspect'>,
    private readonly rootPath: string | null, private readonly logger: RocPluginContext['logger'],
    private readonly run: (input: ResearchProcessRequest) => Promise<ResearchProcessResult> = runResearchProcess) {}

  recover(): void { this.repository.experiments.recover(); }

  async inspect(projectId: string, runtime: ResearchExperimentStartRuntime): Promise<PreparedExperimentEnvironment['snapshot']> {
    return await this.session.run(async (signal) => {
      const workspace = await researchWorkspace(this.repository.getProject(projectId).workspacePath);
      const storage = await experimentStorage(this.rootPath);
      const job = await mkdtemp(join(storage, '.environment-'));
      try { return (await this.environments.inspect(workspace, runtime, job, signal)).snapshot; }
      finally { await rm(job, { recursive: true, force: true }); }
    });
  }

  inspectWorkspace(workspace: string, runtime: ResearchExperimentStartRuntime, scratch: string, signal: AbortSignal): Promise<PreparedExperimentEnvironment> {
    return this.environments.inspect(workspace, runtime, scratch, signal);
  }

  async verifyRun(run: ResearchExperimentExecution, signal: AbortSignal): Promise<string> {
    return this.verifyProject(run, signal);
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
      if (run.status === 'preparing' && !this.executions.has(run.id)) {
        this.executions.start(run.id, { projectId: run.projectId }, (jobSignal) => this.execute(run, jobSignal));
      }
      return run;
    });
  }

  runProcess(request: ResearchProcessRequest): Promise<ResearchProcessResult> {
    return this.run(request);
  }

  abort(id: string): void { this.executions.abort(id); }

  async cancel(projectId: string, id: string): Promise<ResearchExperimentExecution> {
    this.session.requireOpen();
    const run = this.repository.experiments.get(projectId, id);
    if (!['preparing', 'running'].includes(run.status)) return run;
    const task = this.executions.get(id);
    if (task !== undefined) {
      this.executions.abort(id);
      await this.executions.wait(id);
      return this.repository.experiments.get(projectId, id);
    }
    return this.repository.experiments.finish(projectId, id, { status: 'cancelled', files: run.files, exitCode: null, error: 'research_experiment_cancelled' });
  }

  releaseProject(projectId: string): void {
    this.executions.abortMatching((_id, task) => task.projectId === projectId);
  }

  projectChanged(projectId: string): void {
    const project = this.repository.getProject(projectId);
    this.executions.abortMatching((id, task) => {
      if (task.projectId !== projectId) return false;
      const run = this.repository.experiments.get(projectId, id);
      return project.status === 'archived' || project.workspacePath !== run.workspacePath;
    });
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

  private async execute(initial: ResearchExperimentExecution, signal: AbortSignal): Promise<void> {
    const root = this.repository.experiments.root(initial.projectId, initial.id);
    let files: ResearchExperimentFile[] = [];
    let output: ResearchProcessResult = { exitCode: 1, stdout: '', stderr: '' };
    let failure: unknown;
    let prepared: PreparedExperimentEnvironment | null = null;
    try {
      const parsedRequest = researchExperimentStartSchema.safeParse(initial.request);
      if (!parsedRequest.success) throw new ResearchProcessError('research_experiment_legacy_read_only');
      const request = parsedRequest.data;
      const workspace = await this.verifyProject(initial, signal);
      await mkdir(root, { mode: 0o700 });
      const input = await createResearchDirectory(root, 'input');
      const out = await createResearchDirectory(root, 'output');
      const scratch = await createResearchDirectory(root, 'scratch');
      await createResearchDirectory(root, 'log');
      prepared = await this.environments.inspect(workspace, request.runtime, scratch, signal);
      if (request.expectedEnvironmentHash !== undefined && prepared.snapshot.hash !== request.expectedEnvironmentHash) throw new Error('research_experiment_environment_changed');
      const snapshot = await snapshotExperimentInputs(workspace, input, request, prepared.snapshot, signal);
      files = snapshot.files;
      await this.verifyProject(initial, signal);
      this.repository.experiments.start(initial.projectId, initial.id, prepared.snapshot, files, snapshot.hash);
      output = await this.executeProcess({ request, prepared, input, output: out, scratch, signal });
      if (output.exitCode !== 0) throw new Error('research_experiment_process_failed');
      await this.verifyProject(initial, signal);
      const current = await this.environments.inspect(workspace, request.runtime, scratch, signal);
      if (current.snapshot.hash !== prepared.snapshot.hash) throw new Error('research_experiment_environment_changed');
    } catch (error) {
      failure = error;
      if (error instanceof ResearchProcessError) output = { exitCode: 1, stdout: output.stdout + error.stdout, stderr: output.stderr + error.stderr };
      if (error instanceof ResearchProcessError && error.code === 'research_process_write_limit') {
        try {
          await rm(join(root, 'output'), { recursive: true, force: true });
          await mkdir(join(root, 'output'), { mode: 0o700 });
        } catch {
          failure = new ResearchProcessError('research_experiment_output_cleanup_failed');
        }
      }
    }
    if (files.some((file) => file.area === 'input')) {
      try {
        await this.verifyInputSnapshot(root, files);
      } catch {
        failure = new ResearchProcessError('research_experiment_snapshot_changed');
        output = { exitCode: 1, stdout: output.stdout, stderr: `${output.stderr}research_experiment_snapshot_changed\n` };
        try {
          await rm(join(root, 'output'), { recursive: true, force: true });
          await mkdir(join(root, 'output'), { mode: 0o700 });
        } catch {
          failure = new ResearchProcessError('research_experiment_output_cleanup_failed');
        }
      }
    }
    try {
      await createResearchDirectory(root, 'log');
      await writeFile(join(root, 'log/stdout.txt'), output.stdout, { flag: 'wx', mode: 0o400 });
      await writeFile(join(root, 'log/stderr.txt'), output.stderr, { flag: 'wx', mode: 0o400 });
      files.push(...await collectExperimentFiles(join(root, 'log'), 'log'));
      if (prepared !== null) files.push(...await collectExperimentFiles(join(root, 'output'), 'output'));
      let status: ResearchExperimentExecution['status'];
      let error: string | null;
      if (signal.aborted) {
        status = cancelledExecutionStatus(this.session.isClosed);
        error = cancelledExecutionError(this.session.isClosed);
      } else if (failure === undefined) {
        status = 'completed';
        error = null;
      } else {
        status = 'failed';
        error = errorCode(failure);
      }
      const documents = status === 'completed' ? await this.indexDocuments(initial, files) : [];
      if (status === 'completed') await this.verifyProject(initial, signal);
      this.repository.experiments.finish(initial.projectId, initial.id, { status, files, exitCode: prepared === null ? null : output.exitCode, error }, documents);
    } catch (error) {
      this.repository.experiments.finish(initial.projectId, initial.id, { status: signal.aborted ? cancelledExecutionStatus(this.session.isClosed) : 'failed',
        files, exitCode: output.exitCode, error: signal.aborted ? cancelledExecutionError(this.session.isClosed) : errorCode(error) });
    } finally {
      await rm(join(root, 'scratch'), { recursive: true, force: true });
    }
  }

  private async verifyInputSnapshot(root: string, files: readonly ResearchExperimentFile[]): Promise<void> {
    const expected = files.filter((file) => file.area === 'input');
    const actual = await collectExperimentFiles(join(root, 'input'), 'input');
    const expectedByPath = new Map(expected.map((file) => [file.path, file]));
    if (actual.length !== expected.length || actual.some((file) => {
      const original = expectedByPath.get(file.path);
      return original === undefined || original.sha256 !== file.sha256 || original.size !== file.size;
    })) throw new ResearchProcessError('research_experiment_snapshot_changed');
    for (const file of actual) {
      const info = await lstat(join(root, 'input', file.path));
      if (info.nlink !== 1) throw new ResearchProcessError('research_experiment_snapshot_changed');
    }
  }

  private async executeProcess({ request, prepared, input, output, scratch, signal }: ExecuteProcessInput): Promise<ResearchProcessResult> {
    const writeLimits = [output, scratch].map((path) => ({ path, maxFileBytes: experimentFileLimit, maxTotalBytes: experimentOutputTotalLimit,
      maxFiles: experimentFileCountLimit, maxEntries: experimentDirectoryEntryLimit }));
    if (request.engine === 'typescript') {
      const runtime = prepared.typescriptRuntime;
      if (runtime === null) throw new ResearchProcessError('research_experiment_runtime_mismatch');
      const readablePaths = [...new Set([...prepared.readablePaths, input, runtime.executable])];
      const args = ['--permission', ...readablePaths.map((path) => `--allow-fs-read=${path}`),
        ...[output, scratch].map((path) => `--allow-fs-write=${path}`), runtime.runnerPath];
      const runnerInput = JSON.stringify({ contractVersion: request.sourceVersion, sourcePath: request.sourcePath, inputPaths: request.inputPaths,
        inputDir: input, outputDir: output, parameters: request.parameters, packageEntries: runtime.packageEntries,
        limits: { inputFileBytes: experimentFileLimit, totalInputBytes: experimentInputTotalLimit, csvRows: experimentCsvRowLimit,
          outputFileBytes: experimentFileLimit, totalOutputBytes: experimentOutputTotalLimit, outputFiles: experimentFileCountLimit } });
      if (Buffer.byteLength(runnerInput, 'utf8') > experimentRunnerRequestLimit) throw new ResearchProcessError('research_experiment_request_limit');
      const processRequest: ResearchProcessRequest = {
        command: runtime.executable,
        args,
        additionalExecutables: [runtime.executable],
        cwd: input,
        readablePaths,
        writablePaths: [output, scratch],
        environment: { ...prepared.environment, ELECTRON_RUN_AS_NODE: '1' },
        input: runnerInput,
        maxOutputBytes: 16 * 1024 * 1024,
        writeLimits,
        timeoutMs: request.timeoutMs,
        signal,
        allowGpuAcceleration: false,
        allowPosixSpawn: false,
        networkAccess: request.network === 'enabled' ? 'full' : 'none'
      };
      return await this.run(processRequest);
    }
    const executable = prepared.snapshot.executable;
    const environment = { ...prepared.environment, PATH: `${dirname(executable)}:${prepared.environment.PATH}`, ROC_INPUT_DIR: input, ROC_OUTPUT_DIR: output,
      ROC_PARAMETERS_JSON: JSON.stringify(request.parameters) };
    const source = join(input, request.sourcePath);
    const command = request.engine === 'r' ? rExperimentCommand(prepared.snapshot.basePrefix, executable, ['--vanilla', '--slave', '-f', source, '--args', ...request.arguments])
      : { command: executable, args: [...juliaExperimentFlags, `--project=${input}`, '--', source, ...request.arguments] };
    const processRequest: ResearchProcessRequest = { ...command,
      additionalExecutables: [executable], cwd: input, readablePaths: [...prepared.readablePaths, input],
      writablePaths: [output, scratch], environment,
      writeLimits,
      timeoutMs: request.timeoutMs, signal, allowGpuAcceleration: false, allowPosixSpawn: false, networkAccess: request.network === 'enabled' ? 'full' : 'none' };
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
