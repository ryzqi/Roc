import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  researchPythonEnvironmentSelectSchema, type ResearchPythonEnvironmentSelect, type ResearchPythonEnvironmentGet,
  type ResearchPythonEnvironmentSelection
} from '../../../shared/schemas/research-python-environments';
import type { ResearchEnvironmentProbeResource } from '../../../shared/schemas/research-process-resources';
import { requireResearchHuman } from '../../services/research-human-context';
import { inspectPythonExperimentEnvironment, type InspectedPythonEnvironment } from './experiment-python-probe';
import { pickPythonEnvironment, type PythonEnvironmentPicker } from './python-environment-dialog';
import { runResearchProcess, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { researchContentHash } from './research-files';
import type { ResearchRepository } from './repository';
import type { ResearchProcessScope } from './toolchain';

type ProcessRun = (request: ResearchProcessRequest) => Promise<ResearchProcessResult>;
type Job = { projectId: string; controller: AbortController; done: Promise<unknown> };

export class ResearchPythonEnvironmentService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly repository: ResearchRepository, private readonly picker: PythonEnvironmentPicker = pickPythonEnvironment,
    private readonly run: ProcessRun = runResearchProcess) {}

  async select(input: ResearchPythonEnvironmentSelect): Promise<ResearchPythonEnvironmentSelection | null> {
    const request = researchPythonEnvironmentSelectSchema.parse(input);
    const actor = requireResearchHuman('research.pythonEnvironments.select', request.projectId);
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
    const selectedExecutable = await this.picker(owner, signal);
    signal.throwIfAborted();
    if (selectedExecutable === null) return null;
    this.requireWritable(request.projectId);
    const workspace = this.requireWorkspace(request.projectId), workspacePath = await realpath(workspace);
    const jobDir = await mkdtemp(join(tmpdir(), 'roc-python-selection-'));
    try {
      const inspected = await inspectPythonExperimentEnvironment({
        workspace: workspacePath, selectedExecutable, jobDir, run: this.run, signal,
        admission: { projectId: request.projectId, priority: 'user' }, onProbe: () => undefined
      });
      signal.throwIfAborted();
      this.requireWritable(request.projectId);
      if (this.repository.getProject(request.projectId).workspacePath !== workspace
        || await realpath(workspace) !== workspacePath) throw new Error('research_python_selection_workspace_changed');
      return this.repository.pythonEnvironments.save({
        schemaVersion: 1, id: `python_environment_${randomUUID()}`, request, requestHash: researchContentHash(JSON.stringify(request)),
        actor: { kind: 'user', id: owner }, workspacePath,
        selectedExecutable: inspected.controls.selectedExecutable, executable: inspected.controls.executable,
        prefix: inspected.controls.prefix, basePrefix: inspected.controls.basePrefix,
        version: inspected.report.version, platform: inspected.report.platform, architecture: inspected.report.architecture,
        metadataHash: inspected.metadataHash, codeHash: inspected.code.hash,
        lockFile: { path: 'roc-python.lock.json', size: inspected.lockFile.size, sha256: inspected.lockFile.sha256 }, recordedAt: new Date().toISOString()
      });
    } finally { await rm(jobDir, { recursive: true, force: true }); }
  }
}
