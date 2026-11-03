import { ZodError } from 'zod';

import type { ResearchStageRun, ResearchStageRunIdRequest, ResearchStageRunRetryRequest, ResearchStageRunStartRequest, ResearchWorkflowTransitionRequest } from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';
import type { ResearchRepository } from './repository';
import type { PreparedResearchRole, ResearchRoleExecutor } from './role-executor';
import { createResearchRoleTools } from './role-tools';
import type { ResearchProductionEffectService } from './production-effects';
import type { ResearchHumanGate } from './human-gate';
import { assertResearchDispatchGrant, type ConsumedResearchDispatchGrant } from '../../services/deep-agent/execution-grant-broker';
import { researchDispatchRequestHash } from '../../services/research-dispatch-context';

type ActiveRole = { controller: AbortController; pending: Promise<void>; cleanup: Promise<void>; projectId: string };

export class ResearchStageRuntime {
  private readonly active = new Map<string, ActiveRole>();

  private readonly gate: ResearchHumanGate;

  constructor(
    private readonly repository: ResearchRepository,
    private readonly capabilities: RocCapabilityRegistry,
    private readonly executor: ResearchRoleExecutor | undefined,
    gate: ResearchHumanGate,
    private readonly effects?: ResearchProductionEffectService
  ) {
    if (gate === undefined || gate === null) throw new Error('research_human_gate_required');
    this.gate = gate;
  }

  start(request: ResearchStageRunStartRequest, dispatch: ConsumedResearchDispatchGrant | null = null): ResearchStageRun {
    if (this.executor === undefined) throw new Error('research_model_executor_unavailable');
    if (dispatch !== null) {
      assertResearchDispatchGrant(dispatch);
      if (dispatch.requestHash !== researchDispatchRequestHash(request)) throw new Error('research_dispatch_request_mismatch');
    }
    const run = this.repository.runs.begin(request);
    return this.linkAndSchedule(run, dispatch);
  }

  retry(request: ResearchStageRunRetryRequest): ResearchStageRun {
    if (this.executor === undefined) throw new Error('research_model_executor_unavailable');
    const execution = this.repository.tasks.requireExecution('stage', request.runId, request.projectId);
    const task = this.repository.tasks.get(execution.taskId, request.projectId);
    if (['paused', 'interrupted', 'failed'].includes(task.status)) {
      return this.repository.tasks.continueWith(task.id, task.projectId, () => this.retry(request));
    }
    this.repository.tasks.budgetForExecution('stage', request.runId, request.projectId);
    const run = this.repository.runs.retry(request);
    return this.linkAndSchedule(run, null);
  }

  cancel(request: ResearchStageRunIdRequest): ResearchStageRun {
    return this.stop(request, 'cancelled', 'research_run_cancelled');
  }

  transition(request: ResearchWorkflowTransitionRequest) {
    if (request.action === 'complete' || request.action === 'approve' || request.action === 'reject') {
      throw new Error('research_gate_required');
    }
    const workflow = this.repository.getWorkflow(request.projectId);
    if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
    const current = workflow.stages.find((stage) => stage.stage === workflow.currentStage);
    if (request.action === 'pause' && current?.activeRunId !== null && current?.activeRunId !== undefined) {
      this.stop({ projectId: request.projectId, runId: current.activeRunId }, 'interrupted', 'research_run_paused');
      return this.repository.getWorkflow(request.projectId);
    }
    return this.repository.transitionWorkflow(request);
  }

  releaseProject(projectId: string): void {
    for (const entry of this.active.values()) {
      if (entry.projectId !== projectId) continue;
      entry.controller.abort(new Error('research_project_deleted'));
      void entry.pending.catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    const pending = [...this.active.values()].map((entry) => entry.cleanup);
    for (const [runId, entry] of this.active) {
      this.stop({ projectId: entry.projectId, runId }, 'interrupted', 'research_run_interrupted_by_shutdown');
    }
    await Promise.all(pending);
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.active.values()].map((entry) => entry.cleanup));
  }

  async cancelTask(taskId: string, projectId: string): Promise<void> {
    await this.stopTask(taskId, projectId, 'cancelled', 'research_task_cancelled');
  }

  async pauseTask(taskId: string, projectId: string): Promise<void> {
    await this.stopTask(taskId, projectId, 'interrupted', 'research_task_paused');
  }

  async stopTask(taskId: string, projectId: string, status: 'cancelled' | 'interrupted', reason: string): Promise<void> {
    const runs = this.repository.tasks.executions(taskId, projectId)
      .filter((execution) => execution.kind === 'stage')
      .map((execution) => this.repository.runs.get(execution.executionId, projectId));
    const pending: Promise<void>[] = [];
    for (const run of runs) {
      this.repository.runs.terminate(run.id, projectId, status, reason);
      const active = this.active.get(run.id);
      if (active !== undefined) {
        active.controller.abort(new Error(reason));
        pending.push(active.cleanup);
      }
      if (this.effects !== undefined) pending.push(this.effects.cancelOwned(projectId, run.id));
    }
    const results = await Promise.allSettled(pending);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'research_task_stage_cleanup_failed');
  }

  continueTask(request: { taskId: string; projectId: string; runId: string; requestId: string }): ResearchStageRun {
    const execution = this.repository.tasks.requireExecution('stage', request.runId, request.projectId);
    if (execution.taskId !== request.taskId) throw new Error('research_task_execution_conflict');
    return this.repository.tasks.continueWith(request.taskId, request.projectId, () => this.retry({
      projectId: request.projectId, runId: request.runId, requestId: request.requestId
    }));
  }

  restoreTaskApproval(request: { taskId: string; projectId: string }) {
    const workflow = this.repository.getWorkflow(request.projectId);
    const current = workflow.stages.find(stage => stage.stage === workflow.currentStage);
    if (current?.status !== 'waiting_approval' ||
      !this.repository.runs.taskIdsForStage(request.projectId, workflow.currentStage).includes(request.taskId)) {
      throw new Error('research_task_approval_not_waiting');
    }
    return this.repository.tasks.setStatus(request.taskId, request.projectId, 'waiting_approval',
      'research_task_waiting_approval', ['paused']);
  }

  private stop(request: ResearchStageRunIdRequest, status: 'cancelled' | 'interrupted', reason: string): ResearchStageRun {
    const previous = this.repository.runs.get(request.runId, request.projectId);
    if (previous.parentRunId !== null) {
      throw new Error('research_run_cancel_parent_required');
    }
    if (previous.taskId !== null && (['queued', 'running'].includes(previous.status) || this.active.has(previous.id))) {
      const task = this.repository.tasks.get(previous.taskId, previous.projectId);
      if (task.status === 'active') {
        this.repository.tasks.setStatus(task.id, task.projectId,
          status === 'cancelled' ? 'cancelled' : reason === 'research_run_paused' ? 'paused' : 'interrupted',
          reason, ['active']);
      }
    }
    const run = this.repository.runs.terminate(request.runId, request.projectId, status, reason);
    const active = this.active.get(run.id);
    active?.controller.abort(new Error(reason));
    if (['queued', 'running'].includes(previous.status) && this.effects !== undefined) {
      const cleanup = this.effects.cancelOwned(run.projectId, run.id);
      if (active !== undefined) active.cleanup = Promise.allSettled([active.pending, cleanup]).then(() => undefined);
    }
    return run;
  }

  private schedule(run: ResearchStageRun): void {
    if (run.status !== 'queued' || this.active.has(run.id)) return;
    const controller = new AbortController();
    const pending = Promise.resolve().then(() => this.execute(run, controller)).finally(() => {
      this.active.delete(run.id);
    });
    this.active.set(run.id, { controller, pending, cleanup: pending, projectId: run.projectId });
  }

  private linkAndSchedule(run: ResearchStageRun, dispatch: ConsumedResearchDispatchGrant | null): ResearchStageRun {
    try {
      this.repository.tasks.linkStage(run, dispatch);
      const linked = this.repository.runs.bindTask(run.id, run.projectId);
      this.schedule(linked);
      return linked;
    } catch (error) {
      if (run.taskId === null && ['queued', 'running'].includes(run.status)) {
        this.repository.runs.terminate(run.id, run.projectId, 'failed', executionErrorCode(error));
      }
      throw error;
    }
  }

  private async execute(queued: ResearchStageRun, controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort(new Error('research_run_timeout')), queued.policy.timeoutMs);
    let children: Promise<ResearchStageRun>[] = [];
    try {
      const { prepared, run } = await this.prepareRole(queued, controller.signal);
      if (run.stage === 'review') {
        children = this.repository.runs.createReviewChildren(run.id, run.projectId)
          .map((child) => {
            this.repository.tasks.linkStage(child, null);
            return this.executeChild(this.repository.runs.bindTask(child.id, child.projectId), controller.signal);
          });
        const reports = await Promise.all(children);
        this.repository.runs.setReviewReports(run.id, run.projectId, reports);
      }
      await this.executeOutput(run, prepared, controller.signal);
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(children);
      const task = queued.taskId === null ? null : this.repository.tasks.get(queued.taskId, queued.projectId);
      if (task?.status === 'active') {
        this.repository.tasks.setStatus(task.id, task.projectId,
          controller.signal.reason instanceof Error && controller.signal.reason.message === 'research_run_interrupted_by_shutdown'
            ? 'interrupted' : 'failed', executionErrorCode(error), ['active']);
      }
      if (this.repository.runs.get(queued.id, queued.projectId).status === 'completed') return;
      this.repository.runs.terminate(queued.id, queued.projectId, 'failed', executionErrorCode(error));
      await this.effects?.cancelOwned(queued.projectId, queued.id);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async prepareRole(queued: ResearchStageRun, signal: AbortSignal) {
    signal.throwIfAborted();
    this.repository.tasks.requireExecution('stage', queued.id, queued.projectId);
    if (this.executor === undefined) throw new Error('research_model_executor_unavailable');
    const budget = this.repository.tasks.budgetForExecution('stage', queued.id, queued.projectId);
    const prepared = await withAbort(this.executor.prepare(queued.policy.model, budget), signal);
    signal.throwIfAborted();
    return { prepared, run: this.repository.runs.markRunning(queued.id, queued.projectId, prepared) };
  }

  private async executeOutput(run: ResearchStageRun, prepared: PreparedResearchRole, signal: AbortSignal): Promise<ResearchStageRun> {
    const context = this.repository.runs.getContext(run.id);
    const tools = createResearchRoleTools({ run, context, repository: this.repository, capabilities: this.capabilities, signal, effects: this.effects });
    const result = await withAbort(prepared.execute({ run, context, tools, signal }), signal);
    signal.throwIfAborted();
    this.repository.runs.recordModelVersion(run.id, run.projectId, result.modelVersion);
    const completed = this.repository.runs.complete(run.id, run.projectId, result.output);
    if (completed.parentRunId === null) {
      signal.throwIfAborted();
      await this.gate.complete({ projectId: completed.projectId, expectedStage: completed.stage, action: 'complete' }, signal);
      signal.throwIfAborted();
      this.synchronizeTaskState(completed.taskId, completed.projectId);
    }
    return completed;
  }

  synchronizeTaskState(taskId: string | null, projectId: string): void {
    if (taskId === null) throw new Error('research_task_execution_unlinked');
    const task = this.repository.tasks.get(taskId, projectId);
    if (!['active', 'waiting_approval'].includes(task.status)) return;
    const workflow = this.repository.getWorkflow(projectId);
    const current = workflow.stages.find(stage => stage.stage === workflow.currentStage);
    if (current === undefined) throw new Error('research_stage_not_found');
    const status = workflow.projectStatus === 'completed' ? 'completed'
      : current.status === 'waiting_approval' ? 'waiting_approval' : 'active';
    this.repository.tasks.setStatus(taskId, projectId, status,
      status === 'waiting_approval' ? 'research_task_waiting_approval' : null, ['active', 'waiting_approval']);
  }

  private async executeChild(queued: ResearchStageRun, signal: AbortSignal): Promise<ResearchStageRun> {
    try {
      const { prepared, run } = await this.prepareRole(queued, signal);
      return await this.executeOutput(run, prepared, signal);
    } catch (error) {
      this.repository.runs.terminate(queued.id, queued.projectId, signal.aborted ? 'interrupted' : 'failed', executionErrorCode(error));
      throw error;
    }
  }
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function executionErrorCode(error: unknown): string {
  if (error instanceof ZodError) return 'research_role_output_invalid';
  if (error instanceof Error && /^(?:research|run)_[a-z0-9_]+(?::[a-z0-9_.-]+)*$/iu.test(error.message)) return error.message.slice(0, 256);
  return 'research_role_execution_failed';
}
