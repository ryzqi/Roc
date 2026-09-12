import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { researchExperimentFileRequestSchema, researchExperimentStartSchema, type ResearchExperimentExecution, type ResearchExperimentFile,
  type ResearchExperimentRuntime, type ResearchExperimentStart } from '../../../shared/schemas/research-experiments';
import type { RocPluginContext } from '../../kernel/types';
import { ResearchExperimentEnvironmentService, type PreparedExperimentEnvironment } from './experiment-environment';
import { collectExperimentFiles, experimentFileLimit, experimentStorage, snapshotExperimentInputs } from './experiment-files';
import { executePythonNotebook } from './experiment-python';
import { indexText, indexLocatedText } from './index-files';
import { ResearchProcessError, runResearchProcess, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace } from './research-files';
import type { ResearchRepository } from './repository';

type Task = { controller: AbortController; promise: Promise<unknown> };
type FileRequest = z.infer<typeof researchExperimentFileRequestSchema>;

export class ResearchExperimentService {
  private closed = false;
  private readonly tasks = new Set<Task>();
  private readonly executions = new Map<string, Task & { projectId: string }>();

  constructor(private readonly repository: ResearchRepository, private readonly environments: Pick<ResearchExperimentEnvironmentService, 'inspect'>,
    private readonly rootPath: string | null, private readonly logger: RocPluginContext['logger'],
    private readonly run: (input: ResearchProcessRequest) => Promise<ResearchProcessResult> = runResearchProcess) {}

  recover(): void { this.repository.experiments.recover(); }

  async inspect(projectId: string, runtime: ResearchExperimentRuntime): Promise<PreparedExperimentEnvironment['snapshot']> {
    return await this.task(async (signal) => {
      const workspace = await researchWorkspace(this.repository.getProject(projectId).workspacePath);
      const storage = await experimentStorage(this.rootPath);
      const job = await mkdtemp(join(storage, '.environment-'));
      try { return (await this.environments.inspect(workspace, runtime, job, signal)).snapshot; }
      finally { await rm(job, { recursive: true, force: true }); }
    });
  }

  async start(input: ResearchExperimentStart): Promise<ResearchExperimentExecution> {
    const request = researchExperimentStartSchema.parse(input);
    return await this.task(async (signal) => {
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

  async cancel(projectId: string, id: string): Promise<ResearchExperimentExecution> {
    this.requireOpen();
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

  async publish(projectId: string, runId: string): Promise<ResearchExperimentExecution> {
    return await this.task(async (signal) => {
      const run = this.repository.experiments.get(projectId, runId);
      if (run.status !== 'completed') throw new Error('research_experiment_completed_required');
      for (const file of run.files) { signal.throwIfAborted(); await this.source({ projectId, runId, area: file.area, path: file.path }); }
      const { artifactId: _artifactId, ...manifest } = run;
      const content = JSON.stringify(manifest, null, 2);
      const root = this.repository.experiments.root(projectId, runId);
      try { await writeFile(join(root, 'manifest.json'), content, { flag: 'wx', mode: 0o400 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (researchContentHash(await readResearchFile(root, 'manifest.json', experimentFileLimit)) !== researchContentHash(content)) throw new Error('research_experiment_manifest_changed');
      }
      signal.throwIfAborted();
      return this.repository.experiments.publish(projectId, runId);
    });
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
    this.closed = true;
    for (const task of this.tasks) task.controller.abort();
    await Promise.allSettled([...this.tasks].map((task) => task.promise));
  }

  private schedule(run: ResearchExperimentExecution): void {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.execute(run, controller.signal));
    const task = { controller, promise, projectId: run.projectId };
    this.tasks.add(task);
    this.executions.set(run.id, task);
    void promise.catch((error: unknown) => this.logger.error('Research experiment could not persist its final state.', { runId: run.id, error: errorCode(error) }))
      .finally(() => { this.tasks.delete(task); this.executions.delete(run.id); });
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
      await createResearchDirectory(root, 'notebook');
      prepared = await this.environments.inspect(workspace, initial.request.runtime, scratch, signal);
      if (prepared.snapshot.hash !== initial.request.expectedEnvironmentHash) throw new Error('research_experiment_environment_changed');
      if (initial.request.engine === 'notebook' && !prepared.snapshot.packages.some((entry) => entry.name.toLowerCase() === 'ipykernel')) throw new Error('research_experiment_ipykernel_required');
      const snapshot = await snapshotExperimentInputs(workspace, input, initial.request, prepared.snapshot, signal);
      files = snapshot.files;
      await this.verifyProject(initial, signal);
      this.repository.experiments.start(initial.projectId, initial.id, prepared.snapshot, files, snapshot.hash);
      output = await this.executeProcess(initial, prepared, root, input, out, scratch, signal);
      if (output.exitCode !== 0) throw new Error('research_experiment_process_failed');
      await this.verifyProject(initial, signal);
      const current = await this.environments.inspect(workspace, initial.request.runtime, scratch, signal);
      if (current.snapshot.hash !== prepared.snapshot.hash) throw new Error('research_experiment_environment_changed');
    } catch (error) {
      failure = error;
      if (error instanceof ResearchProcessError) output = { exitCode: 1, stdout: error.stdout, stderr: error.stderr };
    }
    try {
      await createResearchDirectory(root, 'log');
      await writeFile(join(root, 'log/stdout.txt'), output.stdout, { flag: 'wx', mode: 0o400 });
      await writeFile(join(root, 'log/stderr.txt'), output.stderr, { flag: 'wx', mode: 0o400 });
      files.push(...await collectExperimentFiles(join(root, 'log'), 'log'));
      if (prepared !== null) {
        files.push(...await collectExperimentFiles(join(root, 'output'), 'output'));
        files.push(...await collectExperimentFiles(join(root, 'notebook'), 'notebook'));
      }
      const status = signal.aborted ? this.closed ? 'interrupted' : 'cancelled' : failure === undefined ? 'completed' : 'failed';
      const error = signal.aborted ? this.closed ? 'research_experiment_interrupted' : 'research_experiment_cancelled' : failure === undefined ? null : errorCode(failure);
      const documents = status === 'completed' ? await this.indexDocuments(initial, files) : [];
      if (status === 'completed') await this.verifyProject(initial, signal);
      this.repository.experiments.finish(initial.projectId, initial.id, { status, files, exitCode: prepared === null ? null : output.exitCode, error }, documents);
    } catch (error) {
      this.repository.experiments.finish(initial.projectId, initial.id, { status: signal.aborted ? this.closed ? 'interrupted' : 'cancelled' : 'failed',
        files, exitCode: output.exitCode, error: errorCode(error) });
    } finally {
      await rm(join(root, 'scratch'), { recursive: true, force: true });
    }
  }

  private async executeProcess(run: ResearchExperimentExecution, prepared: PreparedExperimentEnvironment, root: string, input: string, output: string, scratch: string, signal: AbortSignal): Promise<ResearchProcessResult> {
    const request = run.request;
    const executable = prepared.snapshot.executable;
    const notebook = request.engine === 'notebook';
    const environment = { ...prepared.environment, PYTHONUNBUFFERED: '1', PATH: `${dirname(executable)}:${prepared.environment.PATH}`, ROC_INPUT_DIR: input, ROC_OUTPUT_DIR: output,
      ROC_PARAMETERS_JSON: JSON.stringify(request.parameters), IPYTHONDIR: join(scratch, 'ipython'), JUPYTER_CONFIG_DIR: join(scratch, 'jupyter-config'),
      JUPYTER_RUNTIME_DIR: join(scratch, 'jupyter-runtime'), JUPYTER_PATH: join(scratch, 'jupyter') };
    if (notebook) {
      const kernel = await createResearchDirectory(scratch, 'jupyter/kernels/roc-experiment');
      await writeFile(join(kernel, 'kernel.json'), JSON.stringify({ argv: [executable, '-B', '-s', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
        display_name: 'Roc experiment', language: 'python' }), { flag: 'wx', mode: 0o400 });
    }
    return await this.run({ command: notebook ? prepared.python : executable,
      args: notebook ? ['-I', '-B', '-c', executePythonNotebook, join(input, request.sourcePath), join(root, 'notebook/executed.ipynb'), executable, String(Math.ceil(request.timeoutMs / 1000))]
        : ['-B', '-s', join(input, request.sourcePath), ...request.arguments],
      additionalExecutables: [executable], cwd: input, readablePaths: [...prepared.readablePaths, input],
      writablePaths: [output, scratch, ...notebook ? [join(root, 'notebook')] : []], environment,
      timeoutMs: request.timeoutMs, signal, allowOcrAcceleration: false, allowPosixSpawn: false, networkAccess: request.network === 'enabled' ? 'full' : notebook ? 'loopback' : 'none' });
  }

  private async indexDocuments(run: ResearchExperimentExecution, files: ResearchExperimentFile[]) {
    const documents = [];
    for (const file of files) {
      if (file.area === 'input' || file.size === 0) continue;
      if (file.area !== 'notebook' && (file.size > 4 * 1024 * 1024 || file.area !== 'log' && !['.txt', '.md', '.csv', '.json', '.tsv'].includes(extname(file.path).toLowerCase()))) continue;
      const bytes = await readResearchFile(this.repository.experiments.root(run.projectId, run.id), `${file.area}/${file.path}`, experimentFileLimit);
      if (researchContentHash(bytes) !== file.sha256) throw new Error('research_experiment_snapshot_changed');
      const parsed = file.area === 'notebook' ? indexNotebookOutput(bytes) : indexText(bytes);
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
  private async task<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.requireOpen();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => operation(controller.signal));
    const task = { controller, promise };
    this.tasks.add(task);
    try { return await promise; }
    finally { this.tasks.delete(task); }
  }
  private requireOpen(): void { if (this.closed) throw new Error('research_experiment_closed'); }
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^research_[a-z0-9_]+$/u.test(error.message) ? error.message : 'research_experiment_failed';
}

function indexNotebookOutput(bytes: Buffer): { content: string; chunks: Array<{ content: string; locator: string }> } {
  const text = z.union([z.string(), z.array(z.string())]).transform((value) => typeof value === 'string' ? value : value.join(''));
  const outputSchema = z.discriminatedUnion('output_type', [
    z.object({ output_type: z.literal('stream'), text }),
    z.object({ output_type: z.enum(['execute_result', 'display_data']), data: z.record(z.string(), z.unknown()) }),
    z.object({ output_type: z.literal('error') })
  ]);
  const notebook = z.object({ cells: z.array(z.object({ cell_type: z.string(), outputs: z.array(outputSchema).optional() })) }).parse(JSON.parse(bytes.toString('utf8')));
  const chunks = notebook.cells.flatMap((cell, cellIndex) => {
    if (cell.cell_type !== 'code') return [];
    if (cell.outputs === undefined) throw new Error('research_notebook_outputs_required');
    return cell.outputs.flatMap((output, outputIndex) => {
      const content = output.output_type === 'stream' ? output.text : output.output_type === 'error' || output.data['text/plain'] === undefined ? '' : text.parse(output.data['text/plain']);
      return indexLocatedText(content, `cell ${cellIndex + 1}; output ${outputIndex + 1}`);
    });
  });
  return { content: chunks.map((chunk) => chunk.content).join('\n\n'), chunks };
}
