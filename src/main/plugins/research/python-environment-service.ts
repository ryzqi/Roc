import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  researchPythonEnvironmentPrepareSchema, researchPythonEnvironmentPhaseSchema, researchPythonEnvironmentSnapshotSchema, pythonEnvironmentActivePhases,
  type ResearchPythonEnvironmentPrepare, type ResearchPythonEnvironmentGet, type ResearchPythonEnvironmentCancel,
  type ResearchPythonEnvironmentReceipt, type ResearchPythonEnvironmentSnapshot, type ResearchPythonEnvironmentOperation,
  type ResearchPythonEnvironmentStatus
} from '../../../shared/schemas/research-python-environments';
import type { ResearchEnvironmentProbeResource } from '../../../shared/schemas/research-process-resources';
import { requireResearchHuman } from '../../services/research-human-context';
import { inspectPythonExperimentEnvironment, type InspectedPythonEnvironment } from './experiment-python-probe';
import { prepareProjectPythonEnvironment } from './python-project-environment';
import { pythonEnvironmentLeases } from './python-environment-leases';
import { researchContentHash } from './research-files';
import { runResearchProcess } from './process-runner';
import type { ResearchRepository } from './repository';
import type { ResearchProcessScope } from './toolchain';

type Actor = ResearchPythonEnvironmentSnapshot['actor'];
type Job = { projectId: string; controller: AbortController; done: Promise<void> };
type Options = {
  prepare?: typeof prepareProjectPythonEnvironment;
  inspect?: typeof inspectPythonExperimentEnvironment;
  onError?: (error: unknown) => void;
};
export type PythonRuntimeLease = {
  environment: InspectedPythonEnvironment;
  verify: (onProbe: (receipt: ResearchEnvironmentProbeResource) => void) => Promise<InspectedPythonEnvironment>;
  release: () => void;
};

export class ResearchPythonEnvironmentService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  private readonly prepareProject: typeof prepareProjectPythonEnvironment;
  private readonly inspectEnvironment: typeof inspectPythonExperimentEnvironment;
  constructor(private readonly repository: ResearchRepository, private readonly rootPath: string, private readonly options: Options = {}) {
    this.prepareProject = options.prepare ?? prepareProjectPythonEnvironment;
    this.inspectEnvironment = options.inspect ?? inspectPythonExperimentEnvironment;
    repository.pythonEnvironments.recover();
  }

  prepare(input: ResearchPythonEnvironmentPrepare): Promise<ResearchPythonEnvironmentOperation> {
    return this.start(input, requireResearchHuman('research.pythonEnvironments.prepare', input.projectId), null);
  }
  prepareAutomatic(projectId: string): Promise<ResearchPythonEnvironmentOperation> {
    return this.start({projectId, requestId: `automatic-${randomUUID()}`}, {kind: 'system', id: 'roc-python-environment'}, null);
  }
  prepareOwned(input: ResearchPythonEnvironmentPrepare, ownerRunId: string, signal: AbortSignal): Promise<ResearchPythonEnvironmentOperation> {
    return this.start(input, {kind: 'run', id: ownerRunId}, ownerRunId, signal);
  }
  status(input: {projectId: string}): ResearchPythonEnvironmentStatus { return this.repository.pythonEnvironments.status(input); }
  list(input: {projectId: string}): ResearchPythonEnvironmentReceipt[] { return this.repository.pythonEnvironments.list(input); }

  async cancel(input: ResearchPythonEnvironmentCancel): Promise<ResearchPythonEnvironmentOperation> {
    requireResearchHuman('research.pythonEnvironments.cancel', input.projectId);
    return this.cancelOperation(input);
  }
  async cancelOwned(input: ResearchPythonEnvironmentCancel, ownerRunId: string): Promise<ResearchPythonEnvironmentOperation> {
    const operation = this.repository.pythonEnvironments.operation(input.projectId, input.operationId);
    if (operation.ownerRunId !== ownerRunId) throw new Error('research_python_operation_owner_mismatch');
    return this.cancelOperation(input);
  }
  private async cancelOperation(input: ResearchPythonEnvironmentCancel): Promise<ResearchPythonEnvironmentOperation> {
    const operation = this.repository.pythonEnvironments.operation(input.projectId, input.operationId);
    const job = this.jobs.get(operation.id);
    job?.controller.abort(new Error('research_python_preparation_cancelled'));
    await job?.done;
    return this.repository.pythonEnvironments.operation(input.projectId, input.operationId);
  }

  private async start(input: ResearchPythonEnvironmentPrepare, actor: Actor, ownerRunId: string | null,
    ownerSignal?: AbortSignal): Promise<ResearchPythonEnvironmentOperation> {
    const request = researchPythonEnvironmentPrepareSchema.parse(input);
    if (this.closed) throw new Error('research_python_environment_service_closed');
    ownerSignal?.throwIfAborted(); this.requireWritable(request.projectId, ownerRunId);
    const previous = this.repository.pythonEnvironments.findOperation(request);
    if (previous !== null) {
      if (JSON.stringify(previous.actor) !== JSON.stringify(actor)) throw new Error('research_python_operation_request_conflict');
      return previous;
    }
    const workspace = this.workspace(request.projectId), workspacePath = await realpath(workspace).catch(() => resolve(workspace));
    ownerSignal?.throwIfAborted();
    if (this.closed) throw new Error('research_python_environment_service_closed');
    this.requireWritable(request.projectId, ownerRunId);
    if (this.workspace(request.projectId) !== workspace) throw new Error('research_python_environment_workspace_changed');
    const repeated = this.repository.pythonEnvironments.findOperation(request);
    if (repeated !== null) {
      if (JSON.stringify(repeated.actor) !== JSON.stringify(actor)) throw new Error('research_python_operation_request_conflict');
      return repeated;
    }
    const active = this.status({projectId: request.projectId}).operation;
    if (active !== null && pythonEnvironmentActivePhases.has(active.phase)) return active;
    const timestamp = new Date().toISOString();
    const operation = this.repository.pythonEnvironments.saveOperation({schemaVersion: 1, id: `python_prepare_${randomUUID()}`,
      request, actor, ownerRunId, workspacePath, phase: 'queued', errorCode: null, environmentRef: null,
      startedAt: timestamp, updatedAt: timestamp});
    const controller = new AbortController();
    const abort = () => controller.abort(ownerSignal?.reason ?? new Error('research_python_preparation_cancelled'));
    ownerSignal?.addEventListener('abort', abort, {once: true});
    if (ownerSignal?.aborted) abort();
    const done = this.runPreparation(operation, workspace, controller.signal).catch(error => {
      if (this.options.onError) this.options.onError(error);
      else console.error('Research Python preparation could not persist its final state.', error);
    }).finally(() => {
      ownerSignal?.removeEventListener('abort', abort); this.jobs.delete(operation.id);
    });
    this.jobs.set(operation.id, {projectId: request.projectId, controller, done});
    return operation;
  }

  private async runPreparation(initial: ResearchPythonEnvironmentOperation, workspace: string, signal: AbortSignal): Promise<void> {
    let current = initial, release: (() => void) | undefined;
    const fence = () => {
      signal.throwIfAborted(); this.requireWritable(initial.request.projectId, initial.ownerRunId);
      if (this.workspace(initial.request.projectId) !== workspace) throw new Error('research_python_environment_workspace_changed');
    };
    try {
      release = await pythonEnvironmentLeases.acquire(initial.workspacePath, 'write', signal);
      fence();
      if (await realpath(workspace) !== initial.workspacePath) throw new Error('research_python_environment_workspace_changed');
      fence();
      const previous = this.repository.pythonEnvironments.list({projectId: initial.request.projectId}).findLast(
        receipt => receipt.snapshot.workspacePath === initial.workspacePath);
      const {inspected, runtime} = await this.prepareProject({workspace: initial.workspacePath,
        projectId: initial.request.projectId, rootPath: this.rootPath, signal,
        ...(previous === undefined ? {} : {previousCodeHash: previous.snapshot.codeHash}), onPhase: phase => {
          fence();
          const parsed = researchPythonEnvironmentPhaseSchema.parse(phase);
          if (!pythonEnvironmentActivePhases.has(parsed)) throw new Error('research_python_preparation_phase_invalid');
          current = this.repository.pythonEnvironments.saveOperation({...current, phase: parsed, updatedAt: new Date().toISOString()});
        }});
      fence();
      if (await realpath(workspace) !== initial.workspacePath) throw new Error('research_python_environment_workspace_changed');
      fence();
      const snapshot: ResearchPythonEnvironmentSnapshot = researchPythonEnvironmentSnapshotSchema.parse({
        schemaVersion: 2, id: `python_environment_${randomUUID()}`, request: initial.request,
        requestHash: researchContentHash(JSON.stringify(initial.request)), actor: initial.actor, workspacePath: initial.workspacePath,
        selectedExecutable: inspected.controls.selectedExecutable, executable: inspected.controls.executable,
        prefix: inspected.controls.prefix, basePrefix: inspected.controls.basePrefix,
        version: inspected.report.version, platform: inspected.report.platform, architecture: inspected.report.architecture,
        metadataHash: inspected.metadataHash, codeHash: inspected.code.hash, lockFiles: inspected.lockFiles,
        managedRuntime: {version: runtime.version, pythonKey: runtime.pythonKey, uvHash: runtime.uvHash, receiptHash: runtime.receiptHash},
        recordedAt: new Date().toISOString()
      });
      this.repository.pythonEnvironments.complete(current, snapshot);
    } catch (error) {
      const code = error instanceof Error && error.message ? error.message : 'research_python_preparation_failed';
      this.repository.pythonEnvironments.saveOperation({...current,
        phase: signal.aborted ? 'cancelled' : 'failed', errorCode: code.slice(0, 300), updatedAt: new Date().toISOString()});
    } finally { release?.(); }
  }

  /** The lease remains held through computation and its final identity verification. No uv runs here. */
  async acquireRuntime(input: ResearchPythonEnvironmentGet, jobDir: string, signal: AbortSignal,
    admission: ResearchProcessScope, onProbe: (receipt: ResearchEnvironmentProbeResource) => void): Promise<PythonRuntimeLease> {
    if (this.closed) throw new Error('research_python_environment_service_closed');
    if (admission.projectId !== input.projectId) throw new Error('research_python_environment_admission_mismatch');
    this.requireWritable(input.projectId, null);
    const receipt = this.repository.pythonEnvironments.get(input).snapshot;
    const workspace = this.workspace(input.projectId);
    const actual = await realpath(workspace);
    if (actual !== receipt.workspacePath) throw new Error('research_python_environment_workspace_changed');
    const release = await pythonEnvironmentLeases.acquire(actual, 'read', signal);
    let released = false;
    const verify = async (onProbe: (receipt: ResearchEnvironmentProbeResource) => void) => {
      signal.throwIfAborted();
      if (this.closed) throw new Error('research_python_environment_service_closed');
      if (released) throw new Error('research_python_environment_lease_released');
      this.requireWritable(input.projectId, null);
      if (this.workspace(input.projectId) !== workspace || await realpath(workspace) !== receipt.workspacePath)
        throw new Error('research_python_environment_workspace_changed');
      const inspected = await this.inspectEnvironment({workspace: receipt.workspacePath, selectedExecutable: receipt.selectedExecutable,
        jobDir, signal, admission, onProbe, run: runResearchProcess});
      signal.throwIfAborted(); this.requireWritable(input.projectId, null);
      if (this.workspace(input.projectId) !== workspace || await realpath(workspace) !== receipt.workspacePath)
        throw new Error('research_python_environment_workspace_changed');
      if (inspected.metadataHash !== receipt.metadataHash || inspected.code.hash !== receipt.codeHash
        || JSON.stringify(inspected.lockFiles) !== JSON.stringify(receipt.lockFiles)) throw new Error('research_python_environment_changed');
      return inspected;
    };
    try { return {environment: await verify(onProbe), verify, release: () => { if (!released) {released = true; release();} }}; }
    catch (error) { release(); throw error; }
  }

  async releaseProject(projectId: string): Promise<void> {
    const jobs = [...this.jobs.values()].filter(job => job.projectId === projectId);
    for (const job of jobs) job.controller.abort(new Error('research_python_preparation_cancelled'));
    await Promise.all(jobs.map(job => job.done));
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('research_python_preparation_cancelled'));
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
  private requireWritable(projectId: string, ownerRunId: string | null): void {
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
    if (ownerRunId !== null && this.repository.runs.requireActive(ownerRunId, projectId).status !== 'running')
      throw new Error('research_run_not_current');
  }
  private workspace(projectId: string): string {
    const workspace = this.repository.getProject(projectId).workspacePath;
    if (workspace === null) throw new Error('research_workspace_required');
    return workspace;
  }
}
