import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, sep } from 'node:path';
import { release } from 'node:os';
import { z } from 'zod';
import { notebookExperimentPaths, researchPythonSourcePath, researchExperimentFileRequestSchema, researchExperimentStartSchema, type ResearchExperimentExecution, type ResearchExperimentFile,
  type ResearchExperimentRuntime, type ResearchExperimentStart } from '../../../shared/schemas/research-experiments';
import type { RocPluginContext } from '../../kernel/types';
import { ResearchExperimentEnvironmentService, type PreparedExperimentEnvironment } from './experiment-environment';
import { assertNativeCodeReceipt, nativeCodeReportSchema } from './experiment-native-code-schema';
import { assertPythonCodeReceipt, pythonCodeReportSchema } from './experiment-python-code-schema';
import { runPythonExperimentProcess, pythonExecutionReportSchema, pythonExecutionStartupSchema,
  pythonExperimentBootstrapHash, pythonExperimentToolchainHash, type PythonExecutionStartup } from './experiment-python-process';
import { collectExperimentFiles, experimentCsvRowLimit, experimentFileLimit, experimentInputTotalLimit, experimentOutputTotalLimit,
  experimentRunnerRequestLimit, experimentFileCountLimit, experimentDirectoryEntryLimit, experimentStorage, snapshotExperimentInputs } from './experiment-files';
import { juliaExperimentFlags, rExperimentCommand } from './experiment-native-probes';
import { runRExperimentProcess } from './experiment-native-process';
import { indexText } from './index-files';
import { ResearchProcessError, runResearchProcess, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { researchProcessGuardHash } from './process-guard';
import { writeFrozenManifest } from './research-frozen-manifest';
import { ResearchBackgroundJobs, ResearchJobSession } from './research-job-session';
import { createResearchDirectory, readResearchFile, researchContentHash, researchRelativePath, researchWorkspace } from './research-files';
import type { ResearchRepository } from './repository';
import { researchExperimentResourceReportSchema, type ResearchExperimentResourceReport } from '../../../shared/schemas/research-process-resources';
import { notebookPythonSource } from './notebook-python-source';
import {researchExperimentResultEvidenceMetadataSchema} from '../../../shared/schemas/research-experiment-results';
import {assertExperimentMetricEvidence} from './experiment-result-evidence';

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

function computationPolicy(request: ResearchExperimentStart): ResearchExperimentResourceReport['policy'] {
  return {
    timeoutMs: request.timeoutMs, maxOutputBytes: 16 * 1024 * 1024,
    fileLimits: { maxFileBytes: experimentFileLimit, maxTotalBytes: experimentOutputTotalLimit,
      maxFiles: experimentFileCountLimit, maxEntries: experimentDirectoryEntryLimit },
    resourceLimits: { mode: 'monitored', cpuTimeMs: request.timeoutMs * 4, maxResidentBytes: 2 * 1024 ** 3 },
    allowGpuAcceleration: false, networkAccess: 'none'
  };
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

  async inspect(projectId: string, runtime: ResearchExperimentRuntime): Promise<PreparedExperimentEnvironment['snapshot']> {
    return await this.session.run(async (signal) => {
      const workspace = await researchWorkspace(this.repository.getProject(projectId).workspacePath);
      const storage = await experimentStorage(this.rootPath);
      const job = await mkdtemp(join(storage, '.environment-'));
      try { return (await this.environments.inspect(workspace, runtime, job, signal, { projectId, priority: 'user' }, () => {})).snapshot; }
      finally { await rm(job, { recursive: true, force: true }); }
    });
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
      if (request.engine === 'python' && run.status !== 'preparing') {
        await this.verifyWorkspaceInputs(workspace, run, signal);
        if (run.inputHash !== null) await this.verifyNotebookInputs(run);
      }
      try {
        this.repository.tasks.linkOwned({ kind: 'experiment', executionId: run.id, projectId: run.projectId,
          ownerRunId: run.ownerRunId, goal: request.label, snapshot: run.request });
      } catch (error) {
        this.repository.experiments.finish(run.projectId, run.id, {
          status: 'failed', files: run.files, exitCode: null, error: 'research_task_association_failed'
        });
        throw error;
      }
      if (run.status === 'preparing' && !this.executions.has(run.id)) {
        this.executions.start(run.id, { projectId: run.projectId }, (jobSignal) => this.execute(run, jobSignal));
      }
      return run;
    });
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
      await this.verifyResources(run);
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

  async verifyPublication(projectId: string, artifactId: string): Promise<ResearchExperimentExecution> {
    return this.session.run(async signal => {
      const artifact = this.repository.getArtifact(artifactId);
      if (artifact.projectId !== projectId) throw new Error('research_experiment_project_mismatch');
      const run = this.repository.experiments.forArtifact(artifact);
      const {artifactId: _artifactId, ...manifest} = run;
      const bytes = await readResearchFile(this.repository.experiments.root(projectId, run.id), 'manifest.json', experimentFileLimit);
      if (researchContentHash(bytes) !== researchContentHash(JSON.stringify(manifest, null, 2))) {
        throw new Error('research_experiment_manifest_changed');
      }
      for (const file of run.files) {
        signal.throwIfAborted();
        await this.source({projectId, runId: run.id, area: file.area, path: file.path});
      }
      await this.verifyResources(run);
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
    if(metadata?.type==='experiment-result') {
      const source=researchExperimentResultEvidenceMetadataSchema.parse(metadata);
      const receipt=this.repository.experimentResults.get({projectId,resultId:source.resultId,expectedHash:source.resultHash});
      assertExperimentMetricEvidence(this.repository.evidence.getEvidence(evidenceId,projectId),metadata,receipt);
      return {projectId,runId:source.runId,area:source.area,path:source.path};
    }
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
    let output: Pick<ResearchProcessResult, 'exitCode' | 'stdout' | 'stderr'> = { exitCode: 1, stdout: '', stderr: '' };
    let failure: unknown;
    let prepared: PreparedExperimentEnvironment | null = null;
    let resources: ResearchExperimentResourceReport | null = null;
    const probes: ResearchExperimentResourceReport['probes'] = [];
    try {
      const request = researchExperimentStartSchema.parse(initial.request);
      resources = {
        schemaVersion: 3, runId: initial.id, projectId: initial.projectId, engine: request.engine, probes,
        inputHash: null, environmentHash: null,
        backend: { id: 'macos-seatbelt', contractVersion: 2, kernelRelease: release(), architecture: process.arch,
          cpuHardLimit: false, memoryHardLimit: false, hostCrashCleanup: true, processGuardHash: researchProcessGuardHash() },
        policy: computationPolicy(request), outcome: 'not_dispatched', exitCode: null,
        error: 'research_experiment_not_dispatched', usage: null, admission: null, recordedAt: new Date().toISOString()
      };
      const workspace = await this.verifyProject(initial, signal);
      await mkdir(root, { mode: 0o700 });
      const input = await createResearchDirectory(root, 'input');
      const out = await createResearchDirectory(root, 'output');
      const scratch = await createResearchDirectory(root, 'scratch');
      await createResearchDirectory(root, 'log');
      prepared = await this.environments.inspect(workspace, request.runtime, scratch, signal, { projectId: request.projectId, priority: 'user' },
        receipt => probes.push({ ...receipt, phase: 'preparation' }));
      if (request.expectedEnvironmentHash !== undefined && prepared.snapshot.hash !== request.expectedEnvironmentHash) throw new Error('research_experiment_environment_changed');
      const snapshot = await snapshotExperimentInputs(workspace, input, request, prepared.snapshot, signal, this.notebookInputs(request));
      files = snapshot.files;
      if (request.engine === 'r' || request.engine === 'julia') {
        const native = assertNativeCodeReceipt(prepared.nativeCode, prepared.snapshot.metadataHash);
        const report = JSON.stringify(nativeCodeReportSchema.parse({ schemaVersion: 1, runId: initial.id, projectId: initial.projectId,
          inputHash: snapshot.hash, environmentHash: prepared.snapshot.hash, native }));
        if (Buffer.byteLength(report) > experimentFileLimit) throw new Error('research_experiment_native_code_report_limit');
        await writeFile(join(root, 'log/environment-code.json'), report, { flag: 'wx', mode: 0o400 });
      }
      if (request.engine === 'python') {
        if (prepared.python === null) throw new ResearchProcessError('research_experiment_runtime_mismatch');
        const python = assertPythonCodeReceipt(prepared.python.codeReceipt, prepared.snapshot.metadataHash);
        const report = JSON.stringify(pythonCodeReportSchema.parse({ schemaVersion: 1, runId: initial.id, projectId: initial.projectId,
          inputHash: snapshot.hash, environmentHash: prepared.snapshot.hash, python }));
        if (Buffer.byteLength(report) > experimentFileLimit) throw new Error('research_experiment_python_code_report_limit');
        await writeFile(join(root, 'log/environment-code.json'), report, { flag: 'wx', mode: 0o400 });
      }
      await this.verifyProject(initial, signal);
      this.repository.experiments.start(initial.projectId, initial.id, prepared.snapshot, files, snapshot.hash);
      resources.inputHash = snapshot.hash;
      resources.environmentHash = prepared.snapshot.hash;
      let startup: PythonExecutionStartup | null = null;
      try {
        const executed = await this.executeProcess({ request, prepared, input, output: out, scratch, signal });
        const { result } = executed;
        startup = executed.startup;
        output = result;
        resources = { ...resources, outcome: 'returned', exitCode: result.exitCode, error: null,
          usage: result.resourceUsage, admission: result.admission };
      } catch (error) {
        resources = { ...resources, outcome: 'rejected', error: errorCode(error),
          usage: error instanceof ResearchProcessError ? error.resourceUsage : null,
          admission: error instanceof ResearchProcessError ? error.admission : null };
        throw error;
      }
      if (request.engine === 'python') {
        const report = JSON.stringify(pythonExecutionReportSchema.parse({ schemaVersion: 1,
          runId: initial.id, projectId: initial.projectId, inputHash: snapshot.hash,
          environmentHash: prepared.snapshot.hash, bootstrapHash: pythonExperimentBootstrapHash(), startup }));
        await writeFile(join(root, 'log/python-startup.json'), report, { flag: 'wx', mode: 0o400 });
      }
      if (output.exitCode !== 0) throw new Error('research_experiment_process_failed');
      await this.verifyProject(initial, signal);
      if (request.engine === 'python') await this.verifyWorkspaceInputs(workspace, { ...initial, files: snapshot.files }, signal);
      const current = await this.environments.inspect(workspace, request.runtime, scratch, signal, { projectId: request.projectId, priority: 'user' },
        receipt => probes.push({ ...receipt, phase: 'verification' }));
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
      if (resources !== null) {
        if (resources.outcome === 'not_dispatched') resources.error = errorCode(failure);
        resources.recordedAt = new Date().toISOString();
        await writeFile(join(root, 'log/resources.json'), JSON.stringify(researchExperimentResourceReportSchema.parse(resources), null, 2),
          { flag: 'wx', mode: 0o400 });
      }
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

  private notebookInputs(request: ResearchExperimentStart): Record<string, Buffer> {
    if (request.engine !== 'python' || request.source.kind !== 'notebook') return {};
    const original = this.repository.notebooks.source({ projectId: request.projectId,
      notebookId: request.source.notebookId, expectedHash: request.source.expectedHash });
    const generated = notebookPythonSource(original.bytes, original.receipt);
    return {
      [notebookExperimentPaths.source]: Buffer.from(generated.source, 'utf8'),
      [notebookExperimentPaths.original]: original.bytes,
      [notebookExperimentPaths.receipt]: Buffer.from(JSON.stringify(original.receipt), 'utf8')
    };
  }

  private async verifyNotebookInputs(run: ResearchExperimentExecution): Promise<void> {
    for (const [path, expected] of Object.entries(this.notebookInputs(run.request))) {
      const { bytes } = await this.source({ projectId: run.projectId, runId: run.id, area: 'input', path });
      if (bytes.length !== expected.length || researchContentHash(bytes) !== researchContentHash(expected)) {
        throw new Error('research_experiment_notebook_source_changed');
      }
    }
  }

  private async verifyWorkspaceInputs(workspace: string, run: ResearchExperimentExecution, signal: AbortSignal): Promise<void> {
    const generated: readonly string[] = run.request.engine === 'python' && run.request.source.kind === 'notebook'
      ? Object.values(notebookExperimentPaths) : [];
    for (const file of run.files.filter(file => file.area === 'input' && !generated.includes(file.path))) {
      signal.throwIfAborted();
      const bytes = await readResearchFile(workspace, file.path, experimentFileLimit);
      if (bytes.length !== file.size || researchContentHash(bytes) !== file.sha256) throw new Error('research_experiment_input_changed');
    }
  }

  private async executeProcess({ request, prepared, input, output, scratch, signal }: ExecuteProcessInput
  ): Promise<{ result: ResearchProcessResult; startup: PythonExecutionStartup | null }> {
    const { fileLimits, ...policy } = computationPolicy(request);
    const writeLimits = [output, scratch].map((path) => ({ path, ...fileLimits }));
    if (request.engine === 'typescript') {
      const runtime = prepared.typescriptRuntime;
      if (runtime === null) throw new ResearchProcessError('research_experiment_runtime_mismatch');
      const declaredInputPaths = [request.sourcePath, ...request.inputPaths].map((path) => join(input, researchRelativePath(path)));
      const readablePaths = [...new Set([...prepared.readablePaths, input, ...declaredInputPaths, output, `${output}${sep}`, runtime.executable])];
      const permissionReadPaths = [...new Set([...readablePaths, ...runtime.packageRoots.map((path) => `${path}${sep}`)])];
      const args = ['--permission', ...permissionReadPaths.map((path) => `--allow-fs-read=${path}`),
        ...[output, scratch].flatMap((path) => [`--allow-fs-write=${path}`, `--allow-fs-write=${path}${sep}`]), runtime.runnerPath];
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
        writeLimits,
        ...policy,
        admission: { projectId: request.projectId, priority: 'user', resourceClass: 'compute' },
        signal
      };
      return { result: await this.run(processRequest), startup: null };
    }
    if (request.engine === 'python') {
      if (prepared.python === null) throw new ResearchProcessError('research_experiment_runtime_mismatch');
      return runPythonExperimentProcess({ source: request, python: prepared.python, inputDir: input, outputDir: output,
        scratchDir: scratch, policy: { ...policy, writeLimits },
        admission: { projectId: request.projectId, priority: 'user', resourceClass: 'compute' }, signal }, this.run);
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
      ...policy,
      admission: { projectId: request.projectId, priority: 'user', resourceClass: 'compute' },
      signal };
    return { result: request.engine === 'r' ? await runRExperimentProcess(processRequest, this.run) : await this.run(processRequest), startup: null };
  }

  private async indexDocuments(run: ResearchExperimentExecution, files: ResearchExperimentFile[]) {
    const documents = [];
    for (const file of files) {
      if (file.area === 'log' && ['resources.json', 'environment-code.json', 'python-startup.json'].includes(file.path)) continue;
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

  private async verifyResources(run: ResearchExperimentExecution): Promise<void> {
    const { bytes } = await this.source({ projectId: run.projectId, runId: run.id, area: 'log', path: 'resources.json' });
    const report = researchExperimentResourceReportSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (report.runId !== run.id || report.projectId !== run.projectId || report.engine !== run.request.engine
      || report.inputHash !== run.inputHash || report.environmentHash !== run.environment?.hash
      || report.outcome !== 'returned' || report.exitCode !== 0
      || JSON.stringify(report.policy) !== JSON.stringify(computationPolicy(researchExperimentStartSchema.parse(run.request)))) {
      throw new Error('research_experiment_resource_report_changed');
    }
    const expected = run.request.engine === 'typescript' ? 0 : run.request.engine === 'julia' ? 4 : 2;
    if (report.probes.length !== expected || report.probes.some(probe => probe.outcome !== 'returned' || probe.exitCode !== 0)) {
      throw new Error('research_experiment_resource_report_changed');
    }
    if (run.request.engine === 'r' || run.request.engine === 'julia') {
      const { bytes } = await this.source({ projectId: run.projectId, runId: run.id, area: 'log', path: 'environment-code.json' });
      const code = nativeCodeReportSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (run.environment === null || code.runId !== run.id || code.projectId !== run.projectId
        || code.inputHash !== run.inputHash || code.environmentHash !== run.environment.hash) throw new Error('research_experiment_native_code_report_changed');
      assertNativeCodeReceipt(code.native, run.environment.metadataHash);
    }
    if (run.request.engine === 'python') {
      if (run.environment === null) throw new Error('research_experiment_python_code_report_changed');
      const { bytes } = await this.source({ projectId: run.projectId, runId: run.id, area: 'log', path: 'environment-code.json' });
      const code = pythonCodeReportSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (code.runId !== run.id || code.projectId !== run.projectId || code.inputHash !== run.inputHash
        || code.environmentHash !== run.environment.hash) throw new Error('research_experiment_python_code_report_changed');
      const receipt = assertPythonCodeReceipt(code.python, run.environment.metadataHash);
      if (run.environment.hash !== run.request.expectedEnvironmentHash
        || run.environment.toolchainHash !== pythonExperimentToolchainHash(receipt)
        || JSON.stringify(run.environment.runtime) !== JSON.stringify(run.request.runtime)) {
        throw new Error('research_experiment_python_code_report_changed');
      }
      const startupFile = await this.source({ projectId: run.projectId, runId: run.id, area: 'log', path: 'python-startup.json' });
      const execution = pythonExecutionReportSchema.parse(JSON.parse(startupFile.bytes.toString('utf8')) as unknown);
      const { distributions: _distributions, ...report } = receipt.metadataIdentity.report;
      const expectedStartup = pythonExecutionStartupSchema.parse({
        sourceVersion: run.request.sourceVersion, report, seed: run.request.seed,
        modulePaths: [...receipt.metadataIdentity.controls.modulePaths, receipt.metadataIdentity.controls.packagePath],
        sourcePath: join(this.repository.experiments.root(run.projectId, run.id), 'input', researchPythonSourcePath(run.request.source))
      });
      if (execution.runId !== run.id || execution.projectId !== run.projectId || execution.inputHash !== run.inputHash
        || execution.environmentHash !== run.environment.hash || execution.bootstrapHash !== pythonExperimentBootstrapHash()
        || JSON.stringify(execution.startup) !== JSON.stringify(expectedStartup)) {
        throw new Error('research_experiment_python_startup_report_changed');
      }
      await this.verifyNotebookInputs(run);
    }
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^research_[a-z0-9_]+$/u.test(error.message) ? error.message : 'research_experiment_failed';
}
