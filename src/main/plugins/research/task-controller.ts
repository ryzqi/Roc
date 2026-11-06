import type { ResearchTask, ResearchTaskExecution } from '../../../shared/schemas/research-tasks';
import type { ResearchTaskRepository } from './research-task-repository';
import type { ResearchStageRuntime } from './stage-runtime';

type JobKind = Exclude<ResearchTaskExecution['kind'], 'chat' | 'stage'>;
type TaskCancellationServices = {
  stages: Pick<ResearchStageRuntime, 'cancelTask' | 'pauseTask' | 'continueTask' | 'restoreTaskApproval'>;
  cancelChat(runId: string): Promise<unknown>;
  cancelJob(kind: JobKind, projectId: string, executionId: string): Promise<unknown>;
};

/** Persist refusal of new dispatch before aborting any execution; await only this task's cleanup. */
export class ResearchTaskController {
  private readonly cancellations = new Map<string, Promise<ResearchTask>>();

  constructor(private readonly tasks: ResearchTaskRepository, private readonly services: TaskCancellationServices) {}

  cancel(request: { taskId: string; projectId: string }): Promise<ResearchTask> {
    const current = this.tasks.get(request.taskId, request.projectId);
    const pending = this.cancellations.get(request.taskId);
    if (pending !== undefined) return pending;
    const pausing = this.cancellations.get(`${request.taskId}:paused`);
    const reason = current.statusReason === 'research_task_cleanup_failed' ||
      (current.statusReason === 'research_task_cleanup_pending' && pausing === undefined)
      ? 'research_task_cleanup_failed' : 'research_task_cleanup_pending';
    const task = this.tasks.setStatus(request.taskId, request.projectId, 'cancelled', reason,
      ['active', 'waiting_approval', 'paused', 'interrupted', 'failed', 'cancelled']);
    return this.cleanup(task, 'cancelled', pausing);
  }

  pause(request: { taskId: string; projectId: string }): Promise<ResearchTask> {
    const current = this.tasks.get(request.taskId, request.projectId);
    const pending = this.cancellations.get(`${request.taskId}:paused`);
    if (pending !== undefined) return pending;
    if (current.statusReason === 'research_task_cleanup_failed' || current.statusReason === 'research_task_cleanup_pending') {
      throw new Error('research_task_cleanup_unconfirmed');
    }
    const task = this.tasks.setStatus(request.taskId, request.projectId, 'paused', 'research_task_cleanup_pending',
      ['active', 'waiting_approval', 'paused']);
    return this.cleanup(task, 'paused');
  }

  continueTask(request: { taskId: string; projectId: string; runId: string; requestId: string }) {
    this.tasks.get(request.taskId, request.projectId);
    if (this.cancellations.has(request.taskId) || this.cancellations.has(`${request.taskId}:paused`)) {
      throw new Error('research_task_cleanup_pending');
    }
    return this.services.stages.continueTask(request);
  }

  restoreApproval(request: { taskId: string; projectId: string }) {
    const reason = this.tasks.get(request.taskId, request.projectId).statusReason;
    if (reason === 'research_task_cleanup_failed' || reason === 'research_task_cleanup_pending') {
      throw new Error('research_task_cleanup_unconfirmed');
    }
    if (this.cancellations.has(request.taskId) || this.cancellations.has(`${request.taskId}:paused`)) {
      throw new Error('research_task_cleanup_pending');
    }
    return this.services.stages.restoreTaskApproval(request);
  }

  private cleanup(task: ResearchTask, status: 'paused' | 'cancelled', priorCleanup?: Promise<ResearchTask>): Promise<ResearchTask> {
    const key = status === 'cancelled' ? task.id : `${task.id}:paused`;
    let executionList: { executions: ResearchTaskExecution[]; errors: unknown[] };
    try { executionList = this.tasks.executionsForCleanup(task.id, task.projectId); }
    catch (error) { executionList = { executions: [], errors: [error] }; }
    const { executions, errors: executionErrors } = executionList;
    const invoke = (operation: () => Promise<unknown>): Promise<unknown> => {
      try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
    };
    const cleanup = Promise.allSettled([
      ...executionErrors.map((error) => Promise.reject(error)),
      ...(priorCleanup === undefined ? [] : [priorCleanup]),
      invoke(() => status === 'cancelled' ? this.services.stages.cancelTask(task.id, task.projectId)
        : this.services.stages.pauseTask(task.id, task.projectId)),
      ...executions.map((execution) => invoke(() => {
        if (execution.kind === 'stage') return Promise.resolve();
        if (execution.kind === 'chat') return this.services.cancelChat(execution.executionId);
        if (execution.parentKind === 'stage') return Promise.resolve();
        return this.services.cancelJob(execution.kind, task.projectId, execution.executionId);
      }))
    ]).then((results) => {
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) {
        const current = this.tasks.get(task.id, task.projectId);
        this.tasks.setStatus(task.id, task.projectId, current.status, 'research_task_cleanup_failed', [current.status]);
        throw new AggregateError(errors, 'research_task_cleanup_failed');
      }
      const current = this.tasks.get(task.id, task.projectId);
      if (current.status === status && current.statusReason === 'research_task_cleanup_pending') {
        return this.tasks.setStatus(task.id, task.projectId, status,
          status === 'cancelled' ? 'research_task_cancelled' : 'research_task_paused', [status]);
      }
      return current;
    }).finally(() => this.cancellations.delete(key));
    this.cancellations.set(key, cleanup);
    return cleanup;
  }
}
