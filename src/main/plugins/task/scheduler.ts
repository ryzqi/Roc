import type { BackgroundTask, ChatStartRunRequest, ChatStartRunResult, SchedulerStatus } from '../../../shared/types';
import { computeNextRunAt } from './next-run-calculator';
import type { TaskRepository } from './task-repository';

type TaskSchedulerOptions = {
  startRun?: (request: ChatStartRunRequest) => Promise<ChatStartRunResult>;
  maxTimeoutDelayMs?: number;
};

const emptyCapabilities = {
  mcpServers: [],
  skills: []
};
const defaultMaxTimeoutDelayMs = 24 * 24 * 60 * 60 * 1000;

export class TaskScheduler {
  private readonly registeredTasks = new Map<string, BackgroundTask>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly maxTimeoutDelayMs: number;
  private running = false;
  private suspended = false;
  private lastError: string | null = null;

  constructor(
    private readonly repository: TaskRepository,
    private readonly options: TaskSchedulerOptions = {}
  ) {
    this.maxTimeoutDelayMs = options.maxTimeoutDelayMs ?? defaultMaxTimeoutDelayMs;
  }

  start(): void {
    this.running = true;
    this.suspended = false;
    this.registerAllFromDatabase();
  }

  stop(): void {
    this.running = false;
    this.suspended = false;
    this.clearTimers();
    this.registeredTasks.clear();
  }

  suspendAll(): void {
    this.suspended = true;
    this.clearTimers();
  }

  resumeAll(): void {
    if (!this.running) {
      return;
    }
    this.suspended = false;
    this.registerAllFromDatabase();
  }

  handlePowerResume(): void {
    if (!this.running || this.suspended) {
      return;
    }
    this.registerAllFromDatabase();
  }

  registerTask(task: BackgroundTask): void {
    if (!this.isRegistrable(task)) {
      this.registeredTasks.delete(task.id);
      this.clearTimer(task.id);
      return;
    }
    this.registeredTasks.set(task.id, task);
    this.scheduleTask(task);
  }

  unregisterTask(taskId: string): void {
    this.registeredTasks.delete(taskId);
    this.clearTimer(taskId);
  }

  registerAllFromDatabase(): void {
    this.registeredTasks.clear();
    this.clearTimers();
    for (const task of this.repository.listSchedulableBackgroundTasks()) {
      this.registerTask(task);
    }
  }

  getStatus(): SchedulerStatus {
    return {
      running: this.running && !this.suspended,
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
    this.clearTimer(taskId);
    const firedAt = new Date().toISOString();
    this.repository.recordScheduledTaskRun({
      backgroundTaskId: task.id,
      scheduledAt: task.nextRunAt === null ? firedAt : task.nextRunAt,
      status: 'fired',
      taskRunId: runId,
      triggeredAt: firedAt
    });
    const nextRunAt = task.triggerType === 'cron' ? computeNextRunAt(task, new Date()) : null;
    const updated = this.repository.markBackgroundTaskFired({
      taskId: task.id,
      runId,
      firedAt,
      nextRunAt
    });
    this.registerTask(updated);
    return { taskId: task.id, runId };
  }

  private scheduleTask(task: BackgroundTask): void {
    this.clearTimer(task.id);
    if (!this.running || this.suspended || task.status !== 'running' || task.nextRunAt === null) {
      return;
    }
    const delay = Math.max(0, new Date(task.nextRunAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      void this.fire(task.id);
    }, Math.min(delay, this.maxTimeoutDelayMs));
    timer.unref();
    this.timers.set(task.id, timer);
  }

  private async fire(taskId: string): Promise<void> {
    const task = this.repository.findBackgroundTask(taskId);
    if (task === null || task.status !== 'running') {
      this.unregisterTask(taskId);
      return;
    }
    if (this.options.startRun === undefined) {
      this.lastError = 'task_scheduler_starter_missing';
      return;
    }
    try {
      const result = await this.options.startRun({
        input: task.goal,
        mode: 'task',
        taskSource: 'workbench',
        threadId: task.threadId,
        enabledCapabilities: task.enabledCapabilities ?? emptyCapabilities,
        workspacePath: task.workspacePath
      });
      this.runNow(task.id, result.runId);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
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

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(taskId);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
