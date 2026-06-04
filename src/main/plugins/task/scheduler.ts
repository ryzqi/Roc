import type { BackgroundTask, SchedulerStatus } from '../../../shared/types';
import type { TaskRepository } from './task-repository';

export class TaskScheduler {
  private readonly registeredTasks = new Map<string, BackgroundTask>();
  private running = false;
  private lastError: string | null = null;

  constructor(private readonly repository: TaskRepository) {}

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.registeredTasks.clear();
  }

  registerTask(task: BackgroundTask): void {
    if (!this.isRegistrable(task)) {
      this.registeredTasks.delete(task.id);
      return;
    }
    this.registeredTasks.set(task.id, task);
  }

  unregisterTask(taskId: string): void {
    this.registeredTasks.delete(taskId);
  }

  registerAllFromDatabase(): void {
    this.registeredTasks.clear();
    for (const task of this.repository.listSchedulableBackgroundTasks()) {
      this.registerTask(task);
    }
  }

  getStatus(): SchedulerStatus {
    return {
      running: this.running,
      registeredTaskCount: this.registeredTasks.size,
      nextFireAt: this.nextFireAt(),
      recentSkippedCount: this.repository.countRecentSkippedScheduledRuns(),
      lastError: this.lastError
    };
  }

  runNow(taskId: string, runId: string): { taskId: string; runId: string } {
    const task = this.repository.findBackgroundTask(taskId);
    if (task === null) {
      throw new Error('background_task_not_found');
    }
    const firedAt = new Date().toISOString();
    this.repository.recordScheduledTaskRun({
      backgroundTaskId: task.id,
      scheduledAt: task.nextRunAt === null ? firedAt : task.nextRunAt,
      status: 'fired',
      taskRunId: runId,
      triggeredAt: firedAt
    });
    const updated = this.repository.markBackgroundTaskFired({
      taskId: task.id,
      runId,
      firedAt,
      nextRunAt: null
    });
    this.registerTask(updated);
    return { taskId: task.id, runId };
  }

  private nextFireAt(): string | null {
    const next = Array.from(this.registeredTasks.values())
      .map((task) => task.nextRunAt)
      .filter((value): value is string => value !== null)
      .sort()[0];
    if (next === undefined) {
      return null;
    }
    return next;
  }

  private isRegistrable(task: BackgroundTask): boolean {
    if (!task.scheduled || task.nextRunAt === null) {
      return false;
    }
    return task.status === 'running' || task.status === 'pending_confirmation' || task.status === 'paused';
  }
}
