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
import {ResearchTaskFactsService} from './task-facts';
import type { ResearchTaskController } from './task-controller';

type ActiveRole = { controller: AbortController; pending: Promise<void>; cleanup: Promise<void>; projectId: string };

export class ResearchStageRuntime {
  private readonly active = new Map<string, ActiveRole>();
  private readonly cleanups = new Set<Promise<void>>();

  private readonly gate: ResearchHumanGate;
  private taskController: Pick<ResearchTaskController, 'cancel' | 'pause'> | undefined;

  constructor(
    private readonly repository: ResearchRepository,
    private readonly capabilities: RocCapabilityRegistry,
    private readonly executor: ResearchRoleExecutor,
    gate: ResearchHumanGate,
    private readonly effects: ResearchProductionEffectService,
    private readonly onChanged?: (taskId: string, projectId: string) => void
  ) {
    if (executor === undefined || executor === null) throw new Error('research_model_executor_required');
    if (effects === undefined || effects === null) throw new Error('research_effect_coordinator_required');
    if (gate === undefined || gate === null) throw new Error('research_human_gate_required');
    this.gate = gate;
  }

  start(request: ResearchStageRunStartRequest, dispatch: ConsumedResearchDispatchGrant): ResearchStageRun {
    assertResearchDispatchGrant(dispatch);
    if (dispatch.requestHash !== researchDispatchRequestHash(request)) throw new Error('research_dispatch_request_mismatch');
    const run = this.repository.runs.begin(request, undefined, dispatch);
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

  attachTaskController(controller: Pick<ResearchTaskController, 'cancel' | 'pause'>): void {
    if (this.taskController !== undefined) throw new Error('research_task_controller_already_attached');
    this.taskController = controller;
  }

  async cancel(request: ResearchStageRunIdRequest): Promise<ResearchStageRun> {
    const run = this.repository.runs.get(request.runId, request.projectId);
    if (run.parentRunId !== null) throw new Error('research_run_cancel_parent_required');
    if (!['queued', 'running'].includes(run.status) && !this.active.has(run.id)) return run;
    if (run.taskId === null) return this.stop(request, 'cancelled', 'research_run_cancelled');
    if (this.taskController === undefined) throw new Error('research_task_controller_unavailable');
    try {
      await this.taskController.cancel({ taskId: run.taskId, projectId: run.projectId });
      return this.repository.runs.get(run.id, run.projectId);
    } finally { this.notify(run); }
  }

  async transition(request: ResearchWorkflowTransitionRequest) {
    if (request.action === 'complete' || request.action === 'approve' || request.action === 'reject') {
      throw new Error('research_gate_required');
    }
    const workflow = this.repository.getWorkflow(request.projectId);
    if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
    const current = workflow.stages.find((stage) => stage.stage === workflow.currentStage);
    if (request.action === 'pause' && current?.activeRunId !== null && current?.activeRunId !== undefined) {
      const run = this.repository.runs.get(current.activeRunId, request.projectId);
      if (run.taskId === null) throw new Error('research_task_execution_unlinked');
      if (this.taskController === undefined) throw new Error('research_task_controller_unavailable');
      try { await this.taskController.pause({ taskId: run.taskId, projectId: run.projectId }); }
      finally { this.notify(run); }
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
    const errors: unknown[] = [];
    const fenced = new Map<string, { taskId: string; projectId: string }>();
    for (const [runId, entry] of this.active) {
      try {
        const run = this.repository.runs.get(runId, entry.projectId);
        if (run.taskId !== null && !fenced.has(run.taskId)) {
          const task = this.repository.tasks.get(run.taskId, entry.projectId);
          if (task.status === 'active') {
            this.repository.tasks.setStatus(task.id, task.projectId, 'interrupted', 'research_task_cleanup_pending', ['active']);
            fenced.set(task.id, { taskId: task.id, projectId: task.projectId });
          }
        }
      } catch (error) { errors.push(error); }
      try { this.stop({ projectId: entry.projectId, runId }, 'interrupted', 'research_run_interrupted_by_shutdown'); }
      catch (error) {
        errors.push(error);
        entry.controller.abort(new Error('research_run_interrupted_by_shutdown'));
      }
    }
    const pending = new Set([...this.active.values()].map(entry => entry.cleanup));
    for (const cleanup of this.cleanups) pending.add(cleanup);
    const results = await Promise.allSettled(pending);
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
    for (const { taskId, projectId } of fenced.values()) {
      try {
        const task = this.repository.tasks.get(taskId, projectId);
        if (task.status === 'interrupted' && task.statusReason === 'research_task_cleanup_pending') {
          this.repository.tasks.setStatus(taskId, projectId, 'interrupted',
            errors.length === 0 ? 'research_run_interrupted_by_shutdown' : 'research_task_cleanup_failed', ['interrupted']);
        }
      } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'research_shutdown_cleanup_failed');
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.active.values()].map((entry) => entry.cleanup).concat([...this.cleanups]));
  }

  async cancelTask(taskId: string, projectId: string): Promise<void> {
    await this.stopTask(taskId, projectId, 'cancelled', 'research_task_cancelled');
  }

  async pauseTask(taskId: string, projectId: string): Promise<void> {
    await this.stopTask(taskId, projectId, 'interrupted', 'research_task_paused');
  }

  async stopTask(taskId: string, projectId: string, status: 'cancelled' | 'interrupted', reason: string): Promise<void> {
    const result = this.repository.tasks.executionsForCleanup(taskId, projectId);
    const executions = result.executions.filter((execution) => execution.kind === 'stage');
    const pending: Promise<void>[] = result.errors.map((error) => Promise.reject(error));
    for (const execution of executions) {
      const runId = execution.executionId;
      try { this.repository.runs.terminate(runId, projectId, status, reason); }
      catch (error) { pending.push(Promise.reject(error)); }
      const active = this.active.get(runId);
      if (active !== undefined) {
        active.controller.abort(new Error(reason));
        pending.push(active.cleanup);
      }
      try { pending.push(Promise.resolve(this.effects.cancelOwned(projectId, runId))); }
      catch (error) { pending.push(Promise.reject(error)); }
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
    const issue = this.repository.tasks.recoveryIssues(request.taskId, request.projectId)[0];
    if (issue !== undefined) throw new Error(issue);
    if (this.repository.tasks.hasUnresolvedEffects(request.taskId, request.projectId)) {
      throw new Error('research_task_effect_unresolved');
    }
    const workflow = this.repository.getWorkflow(request.projectId);
    if (workflow.projectStatus === 'archived') throw new Error('research_project_archived');
    const current = workflow.stages.find(stage => stage.stage === workflow.currentStage);
    if (current?.status !== 'waiting_approval' ||
      !this.repository.runs.taskIdsForStage(request.projectId, workflow.currentStage).includes(request.taskId)) {
      throw new Error('research_task_approval_not_waiting');
    }
    const run = this.repository.tasks.executions(request.taskId, request.projectId)
      .filter(execution => execution.kind === 'stage' && execution.associationSource !== 'review')
      .map(execution => this.repository.runs.get(execution.executionId, request.projectId))
      .reverse().find(execution => execution.stage === current.stage && execution.status === 'completed');
    if (run === undefined) throw new Error('research_task_approval_not_waiting');
    this.repository.runs.assertInputsCurrent(run);
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
    this.notify(run);
    const active = this.active.get(run.id);
    active?.controller.abort(new Error(reason));
    const effects = this.effects;
    if (['queued', 'running'].includes(previous.status)) {
      const cleanup = Promise.resolve().then(() => effects.cancelOwned(run.projectId, run.id));
      const tracked = Promise.allSettled(active === undefined ? [cleanup] : [active.cleanup, cleanup]).then(results => {
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length > 0) throw new AggregateError(errors, 'research_stage_cleanup_failed');
      });
      this.cleanups.add(tracked);
      void tracked.then(() => this.cleanups.delete(tracked), () => this.cleanups.delete(tracked));
      if (active !== undefined) active.cleanup = tracked;
    }
    return run;
  }

  private schedule(run: ResearchStageRun): void {
    if (run.status !== 'queued' || this.active.has(run.id)) return;
    const controller = new AbortController();
    const pending = Promise.resolve().then(() => this.execute(run, controller)).finally(() => {
      this.active.delete(run.id);
      this.notify(run);
    });
    this.active.set(run.id, { controller, pending, cleanup: pending, projectId: run.projectId });
  }

  private linkAndSchedule(run: ResearchStageRun, dispatch: ConsumedResearchDispatchGrant | null): ResearchStageRun {
    if (run.status === 'queued') this.repository.runs.requireActive(run.id, run.projectId);
    try {
      this.repository.tasks.linkStage(run, dispatch);
      const linked = this.repository.runs.bindTask(run.id, run.projectId);
      this.schedule(linked);
      this.notify(linked);
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
      await this.effects.cancelOwned(queued.projectId, queued.id);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async prepareRole(queued: ResearchStageRun, signal: AbortSignal) {
    signal.throwIfAborted();
    this.repository.tasks.requireExecution('stage', queued.id, queued.projectId);
    this.repository.runs.requireActive(queued.id, queued.projectId);
    if (this.executor === undefined) throw new Error('research_model_executor_unavailable');
    const budget = this.repository.tasks.budgetForExecution('stage', queued.id, queued.projectId);
    const prepared = await withAbort(this.executor.prepare(queued.policy.model, budget), signal);
    signal.throwIfAborted();
    return { prepared, run: this.repository.runs.markRunning(queued.id, queued.projectId, prepared) };
  }

  private async executeOutput(run: ResearchStageRun, prepared: PreparedResearchRole, signal: AbortSignal): Promise<ResearchStageRun> {
    const context = this.repository.runs.getContext(run.id);
    const tools = createResearchRoleTools({ run, context, repository: this.repository, capabilities: this.capabilities, signal, effects: this.effects });
    const association = this.repository.tasks.requireExecution('stage', run.id, run.projectId);
    const taskContext = {
      task: this.repository.tasks.get(association.taskId, run.projectId),
      facts: new ResearchTaskFactsService(this.repository).get({taskId: association.taskId, projectId: run.projectId})
    };
    const result = await withAbort(prepared.execute({
      run, context, taskContext, tools, signal, onBudgetStatus: () => this.notify(run)
    }), signal);
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

  private notify(run: ResearchStageRun): void {
    if (run.taskId !== null) this.onChanged?.(run.taskId, run.projectId);
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
