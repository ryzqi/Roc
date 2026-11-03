import type { ResearchTask, ResearchTaskExecution } from '../../../shared/schemas/research-tasks';
import type { ResearchTaskRepository } from './research-task-repository';
import type { ResearchStageRuntime } from './stage-runtime';

type JobKind = Exclude<ResearchTaskExecution['kind'], 'chat' | 'stage'>;
type TaskCancellationServices = {
  stages: Pick<ResearchStageRuntime, 'cancelTask'>;
  cancelChat(runId: string): Promise<unknown>;
  cancelJob(kind: JobKind, projectId: string, executionId: string): Promise<unknown>;
};

/** Persist refusal of new dispatch before aborting any execution; await only this task's cleanup. */
export class ResearchTaskController {
  private readonly cancellations = new Map<string, Promise<ResearchTask>>();

  constructor(private readonly tasks: ResearchTaskRepository, private readonly services: TaskCancellationServices) {}

  cancel(request: { taskId: string; projectId: string }): Promise<ResearchTask> {
    this.tasks.get(request.taskId, request.projectId);
    const pending = this.cancellations.get(request.taskId);
    if (pending !== undefined) return pending;
    const executions = this.tasks.executions(request.taskId, request.projectId);
    const task = this.tasks.cancel(request.taskId, request.projectId);
    const cleanup = Promise.allSettled([
      this.services.stages.cancelTask(task.id, task.projectId),
      ...executions.map((execution) => {
        if (execution.kind === 'stage') return Promise.resolve();
        if (execution.kind === 'chat') return this.services.cancelChat(execution.executionId);
        if (execution.parentKind === 'stage') return Promise.resolve();
        return this.services.cancelJob(execution.kind, task.projectId, execution.executionId);
      })
    ]).then((results) => {
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'research_task_cleanup_failed');
      return task;
    }).finally(() => this.cancellations.delete(task.id));
    this.cancellations.set(task.id, cleanup);
    return cleanup;
  }
}
