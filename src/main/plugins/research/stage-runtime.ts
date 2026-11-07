import {randomUUID} from 'node:crypto';
import {withResearchWorker, researchWorkerLease} from './execution/worker-context';
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

type ActiveRole = { controller: AbortController; pending: Promise<void>; cleanup: Promise<void>; projectId: string; taskId: string };

export class ResearchStageRuntime {
  private readonly workerId = `research_worker_${randomUUID()}`;
  private closed = false;
  private pumping = false;
  private readonly active = new Map<string, ActiveRole>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly cleanupFailures = new Set<string>();
  private readonly cleanupReasons = new Map<string, string>();

  private readonly gate: ResearchHumanGate;
  private taskController: Pick<ResearchTaskController, 'cancel' | 'pause'> | undefined;

  constructor(
    private readonly repository: ResearchRepository,
    private readonly capabilities: RocCapabilityRegistry,
    private readonly executor: ResearchRoleExecutor,
    gate: ResearchHumanGate,
    private readonly effects: ResearchProductionEffectService,
    private readonly onChanged?: (taskId: string, projectId: string) => void,
    private readonly concurrency: 1 | 2 = 1
  ) {
    if (executor === undefined || executor === null) throw new Error('research_model_executor_required');
    if (effects === undefined || effects === null) throw new Error('research_effect_coordinator_required');
    if (gate === undefined || gate === null) throw new Error('research_human_gate_required');
    this.gate = gate;
  }

  start(request: ResearchStageRunStartRequest, dispatch: ConsumedResearchDispatchGrant): ResearchStageRun {
    if (this.closed) throw new Error('research_scheduler_closed');
    assertResearchDispatchGrant(dispatch);
    if (dispatch.requestHash !== researchDispatchRequestHash(request)) throw new Error('research_dispatch_request_mismatch');
    const run = this.repository.runs.begin(request, undefined, dispatch);
    return this.linkAndSchedule(run, dispatch);
  }

  retry(request: ResearchStageRunRetryRequest): ResearchStageRun {
    if (this.closed) throw new Error('research_scheduler_closed');
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
    this.closed = true;
    const errors: unknown[] = [];
    const fenced = new Map<string, { taskId: string; projectId: string }>();
    // A queued reducer or capacity-blocked task is also owned by this scheduler.
    // Stop each root once so children never pass through the public parent-only cancel path.
    const entries = [...this.active.values(), ...this.repository.tasks.graph.candidates()];
    for (const entry of entries) {
      try {
        if (!fenced.has(entry.taskId)) {
          const task = this.repository.tasks.get(entry.taskId, entry.projectId);
          if (task.status === 'active') {
            this.repository.tasks.setStatus(task.id, task.projectId, 'interrupted', 'research_task_cleanup_pending', ['active']);
          }
          fenced.set(task.id, { taskId: task.id, projectId: task.projectId });
        }
      } catch (error) { errors.push(error); }
    }
    const pending = new Set([...fenced.values()].map(({taskId, projectId}) =>
      this.stopTask(taskId, projectId, 'interrupted', 'research_run_interrupted_by_shutdown')));
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
    while (this.active.size > 0 || this.cleanups.size > 0) {
      await Promise.all([...this.active.values()].map((entry) => entry.cleanup).concat([...this.cleanups]));
    }
  }

  resumeScheduler(): void { this.pump(); }

  /** Resume only the saved output's gate check; no model call and no human decision. */
  async recoverPendingOutputs(): Promise<void> {
    for (const run of this.repository.runs.pendingOutputReviews()) {
      const task = this.repository.tasks.get(run.taskId!, run.projectId);
      if (!['active', 'waiting_approval'].includes(task.status)) continue;
      try {
        this.repository.runs.assertInputsCurrent(run);
        if (this.repository.tasks.hasUnresolvedEffects(task.id, task.projectId)) throw new Error('research_task_effect_unresolved');
        const stage = this.repository.getWorkflow(run.projectId).stages.find(stage => stage.stage === run.stage);
        if (stage?.status === 'running') {
          await this.gate.complete({projectId: run.projectId, expectedStage: run.stage, action: 'complete'});
        }
        this.synchronizeTaskState(task.id, task.projectId);
      } catch (error) {
        this.repository.tasks.setStatus(task.id, task.projectId, 'failed', executionErrorCode(error), ['active', 'waiting_approval']);
      }
      this.notify(run);
    }
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

  private pump(): void {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      for (const node of this.repository.tasks.graph.candidates()) {
        if (this.active.size >= this.concurrency) break;
        if (this.repository.tasks.get(node.taskId, node.projectId).status !== 'active') continue;
        let run: ResearchStageRun;
        let lease;
        try {
          run = this.repository.runs.requireDispatchable(node.executionId, node.projectId);
          lease = this.repository.tasks.graph.claim({nodeId: node.id, projectId: node.projectId,
            workerId: this.workerId, expectedRevision: node.revision, ttlMs: 30_000, concurrency: this.concurrency});
        } catch (error) {
          this.repository.tasks.setStatus(node.taskId, node.projectId, 'failed', 'research_task_cleanup_pending', ['active']);
          const cleanup = this.stopTask(node.taskId, node.projectId, 'interrupted', executionErrorCode(error)).then(() => {
            this.repository.tasks.setStatus(node.taskId, node.projectId, 'failed', executionErrorCode(error), ['failed']);
          }, cleanupError => {
            this.repository.tasks.setStatus(node.taskId, node.projectId, 'failed', 'research_task_cleanup_failed', ['failed']);
            throw cleanupError;
          });
          this.cleanups.add(cleanup);
          const settled = () => { this.cleanups.delete(cleanup); this.pump(); };
          void cleanup.then(settled, settled);
          continue;
        }
        if (lease === null) continue;
        const controller = new AbortController();
        const heartbeat = setInterval(() => {
          try {
            const current = this.repository.tasks.graph.get(lease.nodeId, lease.projectId);
            if (current.lease === null && ['pending_review','done'].includes(current.status)) { clearInterval(heartbeat); return; }
            this.repository.tasks.graph.heartbeat(lease, 30_000);
          }
          catch (error) { controller.abort(error); }
        }, 10_000);
        heartbeat.unref();
        const pending = withResearchWorker(lease, () => Promise.resolve().then(() => this.execute(run, controller)))
          .finally(() => {
            clearInterval(heartbeat);
            this.active.delete(run.id);
            if (![...this.active.values()].some(entry => entry.taskId === node.taskId)) {
              const task = this.repository.tasks.get(node.taskId, node.projectId);
              if (task.status === 'failed' && task.statusReason === 'research_task_cleanup_pending') {
                this.repository.tasks.setStatus(task.id, task.projectId, 'failed', this.cleanupFailures.has(task.id)
                  ? 'research_task_cleanup_failed' : this.cleanupReasons.get(task.id) ?? 'research_role_execution_failed', ['failed']);
                this.cleanupReasons.delete(task.id);
              }
            }
            this.notify(run);
            this.pump();
          });
        // Observe the promise immediately; waitForIdle/shutdown still receive failures.
        void pending.catch(() => undefined);
        this.active.set(run.id, {controller, pending, cleanup: pending, projectId: run.projectId, taskId: node.taskId});
      }
    } finally { this.pumping = false; }
  }

  private linkAndSchedule(run: ResearchStageRun, dispatch: ConsumedResearchDispatchGrant | null): ResearchStageRun {
    if (run.status === 'queued') this.repository.runs.requireDispatchable(run.id, run.projectId);
    try {
      this.repository.tasks.linkStage(run, dispatch);
      const linked = this.repository.runs.bindTask(run.id, run.projectId);
      if (linked.status === 'queued' && linked.stage === 'review' && linked.parentRunId === null) {
        const children = this.repository.runs.createReviewChildren(linked.id, linked.projectId);
        const graph = this.repository.tasks.graph.read(linked.taskId!, linked.projectId);
        const parent = this.repository.tasks.requireExecution('stage', linked.id, linked.projectId).nodeBinding;
        if (parent.kind !== 'dag') throw new Error('research_node_binding_invalid');
        const edges = children.map(child => {
          const binding = this.repository.tasks.requireExecution('stage', child.id, child.projectId).nodeBinding;
          if (binding.kind !== 'dag') throw new Error('research_node_binding_invalid');
          return {prerequisite: binding.nodeId, dependent: parent.nodeId};
        }).filter(edge => !graph.edges.some(saved => saved.prerequisite === edge.prerequisite && saved.dependent === edge.dependent));
        if (edges.length > 0) this.repository.tasks.graph.addDependencies(linked.taskId!, linked.projectId, graph.revision, edges);
      }
      this.pump();
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
    try {
      if (queued.stage === 'review' && queued.parentRunId === null) {
        const children = this.repository.tasks.executions(queued.taskId!, queued.projectId)
          .filter(execution => execution.kind === 'stage' && execution.parentExecutionId === queued.id)
          .map(execution => this.repository.runs.get(execution.executionId, queued.projectId));
        this.repository.runs.setReviewReports(queued.id, queued.projectId, children);
      }
      const { prepared, run } = await this.prepareRole(queued, controller.signal);
      await this.executeOutput(run, prepared, controller.signal);
    } catch (error) {
      controller.abort(error);
      const task = queued.taskId === null ? null : this.repository.tasks.get(queued.taskId, queued.projectId);
      if (task?.status === 'active') {
        this.cleanupReasons.set(task.id, executionErrorCode(error));
        this.repository.tasks.setStatus(task.id, task.projectId,
          controller.signal.reason instanceof Error && controller.signal.reason.message === 'research_run_interrupted_by_shutdown'
            ? 'interrupted' : 'failed', 'research_task_cleanup_pending', ['active']);
      }
      if (this.repository.runs.get(queued.id, queued.projectId).status === 'completed') return;
      this.repository.runs.terminate(queued.id, queued.projectId, 'failed', executionErrorCode(error));
      if (queued.taskId !== null) {
        for (const execution of this.repository.tasks.executions(queued.taskId, queued.projectId)) {
          if (execution.kind !== 'stage' || execution.executionId === queued.id) continue;
          this.repository.runs.terminate(execution.executionId, queued.projectId, 'interrupted', executionErrorCode(error));
          this.active.get(execution.executionId)?.controller.abort(error);
        }
      }
      try { await this.effects.cancelOwned(queued.projectId, queued.id); }
      catch (cleanupError) {
        if (queued.taskId !== null) this.cleanupFailures.add(queued.taskId);
        throw cleanupError;
      }
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
    const loadTaskContext = () => {
      this.repository.runs.requireActive(run.id, run.projectId);
      const association = this.repository.tasks.requireExecution('stage', run.id, run.projectId);
      return {
        task: this.repository.tasks.get(association.taskId, run.projectId),
        facts: new ResearchTaskFactsService(this.repository).get({taskId: association.taskId, projectId: run.projectId})
      };
    };
    const result = await withAbort(prepared.execute({
      run, context, loadTaskContext, tools, signal, onBudgetStatus: () => this.notify(run)
    }), signal);
    signal.throwIfAborted();
    this.repository.tasks.graph.assertLease(researchWorkerLease());
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
