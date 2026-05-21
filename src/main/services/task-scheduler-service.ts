import { existsSync } from 'node:fs';
import type { BackgroundTask, ChatStartRunRequest, ChatStartRunResult, SchedulerStatus } from '../../shared/types';
import { RocDomainError } from './errors';
import type { TaskService } from './task-service';
import { computeNextRunAt } from './task/next-run-calculator';

type RuntimeStarter = {
  startRun: (request: ChatStartRunRequest) => Promise<ChatStartRunResult>;
};

type TaskSchedulerOptions = {
  maxRegisteredTasks?: number;
};

const maxTimeoutDelayMs = 24 * 24 * 60 * 60 * 1000;

export class TaskSchedulerService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly firingTaskIds = new Set<string>();
  private readonly maxRegisteredTasks: number;
  private running = false;
  private suspended = false;
  private lastError: string | null = null;

  constructor(
    private readonly taskService: TaskService,
    private readonly runtimeStarter: RuntimeStarter,
    options: TaskSchedulerOptions = {}
  ) {
    this.maxRegisteredTasks = options.maxRegisteredTasks ?? 256;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.suspended = false;
    this.registerAllFromDatabase('missed_startup');
  }

  stop(): void {
    this.clearTimers();
    this.firingTaskIds.clear();
    this.running = false;
    this.suspended = false;
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
    this.registerAllFromDatabase(null);
  }

  handlePowerResume(): void {
    if (!this.running || this.suspended) {
      return;
    }
    this.clearTimers();
    this.registerAllFromDatabase('missed_resume');
  }

  registerTask(task: BackgroundTask): void {
    if (!this.running || this.suspended || !task.scheduled || task.status !== 'running') {
      return;
    }
    if (!this.timers.has(task.id) && this.timers.size >= this.maxRegisteredTasks) {
      this.lastError = 'scheduler_resource_exhausted';
      throw new RocDomainError({
        code: 'scheduler_resource_exhausted',
        message: '后台任务调度器注册任务数量超过上限。',
        category: 'conflict',
        retryable: false,
        userAction: '请暂停或删除部分后台任务后重试。'
      });
    }

    const nextRunAt = computeNextRunAt(task);
    if (nextRunAt === null) {
      return;
    }

    this.clearTimer(task.id);
    const delay = Math.max(0, new Date(nextRunAt).getTime() - Date.now());
    const safeDelay = Math.min(delay, maxTimeoutDelayMs);
    const timer = setTimeout(() => {
      void this.fire(task.id);
    }, safeDelay);
    this.timers.set(task.id, timer);
  }

  unregisterTask(taskId: string): void {
    this.clearTimer(taskId);
  }

  refreshTask(task: BackgroundTask): void {
    this.unregisterTask(task.id);
    this.registerTask(task);
  }

  async fire(taskId: string): Promise<void> {
    if (this.firingTaskIds.has(taskId)) {
      const task = this.findTask(taskId);
      if (task !== null) {
        this.taskService.recordScheduledTaskRun({
          backgroundTaskId: task.id,
          scheduledAt: task.nextRunAt ?? new Date().toISOString(),
          status: 'skipped',
          skipReason: 'already_running'
        });
      }
      return;
    }

    const task = this.findTask(taskId);
    if (task === null) {
      return;
    }
    this.clearTimer(task.id);
    this.firingTaskIds.add(task.id);

    try {
      const scheduledAt = task.nextRunAt ?? new Date().toISOString();
      const skipReason = this.validateFirePreconditions(task);
      if (skipReason !== null) {
        const skipped = this.taskService.recordScheduledTaskRun({
          backgroundTaskId: task.id,
          scheduledAt,
          status: 'skipped',
          skipReason
        });
        this.taskService.pauseBackgroundTaskForScheduler({
          taskId: task.id,
          runId: skipped.id,
          reason: skipReason
        });
        return;
      }

      const result = await this.runtimeStarter.startRun({
        input: task.goal,
        mode: 'task',
        threadId: task.threadId,
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      const firedAt = new Date().toISOString();
      this.taskService.recordScheduledTaskRun({
        backgroundTaskId: task.id,
        scheduledAt,
        status: 'fired',
        taskRunId: result.runId,
        triggeredAt: firedAt
      });
      const nextRunAt = task.triggerType === 'cron' ? computeNextRunAt(task, new Date()) : null;
      const updated = this.taskService.markBackgroundTaskFired({
        taskId: task.id,
        runId: result.runId,
        firedAt,
        nextRunAt
      });
      if (updated.status === 'running') {
        this.registerTask(updated);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      const failed = this.taskService.recordScheduledTaskRun({
        backgroundTaskId: task.id,
        scheduledAt: task.nextRunAt ?? new Date().toISOString(),
        status: 'failed',
        skipReason: this.lastError
      });
      this.taskService.pauseBackgroundTaskForScheduler({
        taskId: task.id,
        runId: failed.id,
        reason: 'fire_failed'
      });
    } finally {
      this.firingTaskIds.delete(task.id);
    }
  }

  getStatus(): SchedulerStatus {
    const nextFireAt = [...this.timers.keys()]
      .map((taskId) => this.findTask(taskId)?.nextRunAt ?? null)
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;
    return {
      running: this.running && !this.suspended,
      registeredTaskCount: this.timers.size,
      nextFireAt,
      recentSkippedCount: this.countRecentSkippedRuns(),
      lastError: this.lastError
    };
  }

  private registerAllFromDatabase(missedReason: 'missed_startup' | 'missed_resume' | null): void {
    const tasks = this.taskService.listSchedulableBackgroundTasks();
    for (const task of tasks) {
      if (!task.scheduled || task.nextRunAt === null || task.status !== 'running') {
        continue;
      }
      if (new Date(task.nextRunAt).getTime() < Date.now()) {
        if (missedReason === null && task.triggerType === 'cron') {
          const refreshed = this.taskService.updateBackgroundTaskNextRunAt(task.id, computeNextRunAt(task));
          this.registerTask(refreshed);
          continue;
        }
        if (missedReason === null) {
          continue;
        }
        const skipped = this.taskService.recordScheduledTaskRun({
          backgroundTaskId: task.id,
          scheduledAt: task.nextRunAt,
          status: 'skipped',
          skipReason: missedReason
        });
        this.taskService.pauseBackgroundTaskForScheduler({
          taskId: task.id,
          runId: skipped.id,
          reason: missedReason
        });
        continue;
      }
      this.registerTask(task);
    }
  }

  private validateFirePreconditions(task: BackgroundTask): string | null {
    if (task.status !== 'running') {
      return 'not_running';
    }
    if (!existsSync(task.workspacePath)) {
      return 'workspace_unreachable';
    }
    return null;
  }

  private findTask(taskId: string): BackgroundTask | null {
    return this.taskService.listSchedulableBackgroundTasks().find((task) => task.id === taskId) ?? null;
  }

  private countRecentSkippedRuns(): number {
    return this.taskService.countRecentSkippedScheduledRuns(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  }

  private clearTimer(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(taskId);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
