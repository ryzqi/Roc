import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  researchPythonEnvironmentSelectSchema, type ResearchPythonEnvironmentSelect, type ResearchPythonEnvironmentGet,
  type ResearchPythonEnvironmentSelection, type ResearchPythonEnvironmentSnapshot
} from '../../../shared/schemas/research-python-environments';
import type { ResearchEnvironmentProbeResource } from '../../../shared/schemas/research-process-resources';
import { requireResearchHuman } from '../../services/research-human-context';
import { RocDomainError } from '../../services/errors';
import { inspectPythonExperimentEnvironment, readPythonEnvironmentLock, type InspectedPythonEnvironment } from './experiment-python-probe';
import { discoverProjectPythonExecutables } from './python-environment-discovery';
import { ResearchProcessError, runResearchProcess, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { researchContentHash } from './research-files';
import type { ResearchRepository } from './repository';
import type { ResearchProcessScope } from './toolchain';

type ProcessRun = (request: ResearchProcessRequest) => Promise<ResearchProcessResult>;
type PythonEnvironmentPicker = (owner: string, signal: AbortSignal) => Promise<string | null>;
type Job = { projectId: string; controller: AbortController; done: Promise<unknown> };

export class ResearchPythonEnvironmentService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly repository: ResearchRepository, private readonly picker?: PythonEnvironmentPicker,
    private readonly run: ProcessRun = runResearchProcess,
    private readonly discover = discoverProjectPythonExecutables) {}

  async select(input: ResearchPythonEnvironmentSelect): Promise<ResearchPythonEnvironmentSelection | null> {
    const request = researchPythonEnvironmentSelectSchema.parse(input);
    const actor = requireResearchHuman('research.pythonEnvironments.select', request.projectId);
    if (this.picker === undefined) return (await this.list({ projectId: request.projectId })).at(-1) ?? null;
    if (this.closed) throw new Error('research_python_selection_service_closed');
    this.requireWritable(request.projectId);
    const existing = this.repository.pythonEnvironments.findRequest(request);
    if (existing !== null) {
      if (existing.snapshot.actor.id !== actor.id) throw new Error('research_python_selection_request_conflict');
      return existing;
    }
    this.requireWorkspace(request.projectId);
    const key = JSON.stringify([request.projectId, request.requestId]);
    if ([...this.jobs.values()].some(job => job.projectId === request.projectId)) throw new Error('research_python_selection_in_progress');
    const controller = new AbortController();
    const done = this.choose(request, actor.id, controller.signal);
    this.jobs.set(key, { projectId: request.projectId, controller, done });
    try { return await done; } finally { this.jobs.delete(key); }
  }

  /** Prepare the current project automatically, sharing one probe across concurrent consumers. */
  async list(input: { projectId: string }): Promise<ResearchPythonEnvironmentSelection[]> {
    if (this.closed) throw new Error('research_python_selection_service_closed');
    const project = this.repository.getProject(input.projectId);
    if (project.status === 'archived' || project.workspacePath === null) return this.repository.pythonEnvironments.list(input);
    const key = `automatic:${input.projectId}`;
    const existing = this.jobs.get(key);
    if (existing !== undefined) await existing.done;
    else {
      if ([...this.jobs.values()].some(job => job.projectId === input.projectId)) throw new Error('research_python_selection_in_progress');
      const controller = new AbortController();
      const done = this.prepare(input.projectId, controller.signal);
      this.jobs.set(key, { projectId: input.projectId, controller, done });
      try { await done; } finally { this.jobs.delete(key); }
    }
    return this.repository.pythonEnvironments.list(input);
  }

  private async prepare(projectId: string, signal: AbortSignal): Promise<void> {
    const workspace = this.requireWorkspace(projectId);
    const candidates = await this.discover(workspace, signal);
    const previous = this.repository.pythonEnvironments.list({ projectId }).at(-1);
    if (previous?.snapshot.workspacePath === await realpath(workspace)) candidates.unshift(previous.snapshot.selectedExecutable);
    let failure: unknown;
    for (const selectedExecutable of new Set(candidates)) {
      signal.throwIfAborted();
      this.requireWritable(projectId);
      if (this.requireWorkspace(projectId) !== workspace) throw new Error('research_python_selection_workspace_changed');
      try {
        await this.record({ projectId, requestId: `automatic-${randomUUID()}` },
          { kind: 'system', id: 'roc-python-environment' }, selectedExecutable, signal, true);
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RocDomainError && error.code === 'research_python_lock_invalid') throw error;
        failure ??= error;
      }
    }
    if (failure instanceof RocDomainError) throw failure;
    if (failure instanceof Error && ['research_python_runtime_version_mismatch', 'research_python_installed_distributions_mismatch'].includes(failure.message)) {
      throw new RocDomainError({ code: 'research_python_lock_mismatch', category: 'validation', retryable: true,
        message: '本机 Python 版本或依赖与项目锁文件不一致，无法准备实验环境。',
        userAction: '请按项目 roc-python.lock.json 安装对应版本和依赖后重试；已有锁文件不会被覆盖。' });
    }
    throw new RocDomainError({ code: 'research_python_runtime_unavailable', category: 'validation', retryable: true,
      message: '未检测到可用的 CPython 3.14。Roc 会自动检测项目虚拟环境及本机安装，无需选择解释器。',
      userAction: '安装 CPython 3.14 后重试。' });
  }

  /** A selection is usable only after reinspection matches its original complete environment identity. */
  async resolve(input: ResearchPythonEnvironmentGet, jobDir: string, signal: AbortSignal,
    admission: ResearchProcessScope, onProbe: (receipt: ResearchEnvironmentProbeResource) => void): Promise<InspectedPythonEnvironment> {
    if (admission.projectId !== input.projectId) throw new Error('research_python_selection_admission_mismatch');
    this.requireWritable(input.projectId);
    const selection = this.repository.pythonEnvironments.get(input).snapshot;
    const workspace = this.requireWorkspace(input.projectId);
    if (await realpath(workspace) !== selection.workspacePath) throw new Error('research_python_selection_workspace_changed');
    const inspected = await inspectPythonExperimentEnvironment({
      workspace: selection.workspacePath, selectedExecutable: selection.selectedExecutable, jobDir, run: this.run, signal,
      admission, onProbe
    });
    this.requireWritable(input.projectId);
    if (this.repository.getProject(input.projectId).workspacePath !== workspace
      || await realpath(workspace) !== selection.workspacePath) throw new Error('research_python_selection_workspace_changed');
    if (inspected.metadataHash !== selection.metadataHash) throw new Error('research_python_selection_environment_changed');
    return inspected;
  }

  async releaseProject(projectId: string): Promise<void> {
    const jobs = [...this.jobs.values()].filter(job => job.projectId === projectId);
    for (const job of jobs) job.controller.abort(new Error('research_python_selection_cancelled'));
    await Promise.allSettled(jobs.map(job => job.done));
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('research_python_selection_cancelled'));
    await Promise.allSettled([...this.jobs.values()].map(job => job.done));
  }

  private requireWritable(projectId: string): void {
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  private requireWorkspace(projectId: string): string {
    const workspace = this.repository.getProject(projectId).workspacePath;
    if (workspace === null) throw new Error('research_workspace_required');
    return workspace;
  }
  private async choose(request: ResearchPythonEnvironmentSelect, owner: string, signal: AbortSignal): Promise<ResearchPythonEnvironmentSelection | null> {
    await readPythonEnvironmentLock(this.requireWorkspace(request.projectId));
    signal.throwIfAborted();
    const selectedExecutable = await this.picker!(owner, signal);
    signal.throwIfAborted();
    if (selectedExecutable === null) return null;
    return this.record(request, { kind: 'user', id: owner }, selectedExecutable, signal);
  }

  private async record(request: ResearchPythonEnvironmentSelect, actor: ResearchPythonEnvironmentSnapshot['actor'],
    selectedExecutable: string, signal: AbortSignal, initializeLock = false): Promise<ResearchPythonEnvironmentSelection> {
    this.requireWritable(request.projectId);
    const workspace = this.requireWorkspace(request.projectId), workspacePath = await realpath(workspace);
    const jobDir = await mkdtemp(join(tmpdir(), 'roc-python-selection-'));
    try {
      const inspected = await inspectPythonExperimentEnvironment({
        workspace: workspacePath, selectedExecutable, jobDir, run: this.run, signal,
        admission: { projectId: request.projectId, priority: 'user' }, onProbe: () => undefined, initializeLock
      }).catch(error => {
        if (error instanceof ResearchProcessError && error.code === 'research_python_environment_probe_failed'
          && /(?:^|\n)RuntimeError: research_python_direct_dependency_unsupported\s*$/u.test(error.stderr)) {
          throw new RocDomainError({
            code: 'research_python_direct_dependency_unsupported', category: 'validation', retryable: false,
            message: '检测到的 Python 环境包含带 direct_url.json 的直接来源依赖，当前研究运行器不支持此类环境。',
            userAction: '请使用与 roc-python.lock.json 一致的独立项目环境；无第三方依赖的项目可用 python -m venv --without-pip 创建 .venv，Roc 将自动检测。'
          });
        }
        throw error;
      });
      signal.throwIfAborted();
      this.requireWritable(request.projectId);
      if (this.repository.getProject(request.projectId).workspacePath !== workspace
        || await realpath(workspace) !== workspacePath) throw new Error('research_python_selection_workspace_changed');
      if (actor.kind === 'system') {
        const previous = this.repository.pythonEnvironments.list({ projectId: request.projectId }).at(-1);
        if (previous?.snapshot.metadataHash === inspected.metadataHash && previous.snapshot.workspacePath === workspacePath) return previous;
      }
      return this.repository.pythonEnvironments.save({
        schemaVersion: 1, id: `python_environment_${randomUUID()}`, request, requestHash: researchContentHash(JSON.stringify(request)),
        actor, workspacePath,
        selectedExecutable: inspected.controls.selectedExecutable, executable: inspected.controls.executable,
        prefix: inspected.controls.prefix, basePrefix: inspected.controls.basePrefix,
        version: inspected.report.version, platform: inspected.report.platform, architecture: inspected.report.architecture,
        metadataHash: inspected.metadataHash, codeHash: inspected.code.hash,
        lockFile: { path: 'roc-python.lock.json', size: inspected.lockFile.size, sha256: inspected.lockFile.sha256 }, recordedAt: new Date().toISOString()
      });
    } finally { await rm(jobDir, { recursive: true, force: true }); }
  }
}
