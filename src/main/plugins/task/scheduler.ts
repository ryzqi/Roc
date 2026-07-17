import { randomUUID } from 'node:crypto';

import type { BackgroundTask, ChatStartRunRequest, ChatStartRunResult, SchedulerStatus } from '../../../shared/types';
import { computeNextRunAt } from './next-run-calculator';
import type { TaskRepository } from './task-repository';

type TaskSchedulerOptions = {
  startRun?: (request: ChatStartRunRequest) => Promise<ChatStartRunResult>;
  maxTimeoutDelayMs?: number;
};

const defaultMaxTimeoutDelayMs = 24 * 24 * 60 * 60 * 1000;

export class TaskScheduler {
  private readonly registeredTasks = new Map<string, BackgroundTask>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly maxTimeoutDelayMs: number;
  private readonly claimOwner = `task-scheduler-${randomUUID()}`;
  private occurrenceReconcileTimer: NodeJS.Timeout | null = null;
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
    this.reconcile();
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
    this.reconcile();
  }

  handlePowerResume(): void {
    if (!this.running || this.suspended) {
      return;
    }
    this.reconcile();
  }

  reconcile(): void {
    if (!this.running || this.suspended) {
      return;
    }
    this.repository.reconcileScheduledOccurrences({ now: new Date().toISOString() });
    this.registerAllFromDatabase();
    this.scheduleOccurrenceReconcile();
    for (const task of this.repository.listSchedulableBackgroundTasks()) {
      if (this.repository.hasDuePendingScheduledOccurrence({ now: new Date().toISOString(), taskId: task.id })) {
        void this.fire(task.id);
      }
    }
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
    const now = new Date().toISOString();
    const taskDue = task.nextRunAt !== null && Date.parse(task.nextRunAt) <= Date.parse(now);
    const pendingOccurrenceDue = this.repository.hasDuePendingScheduledOccurrence({ now, taskId: task.id });
    if (this.options.startRun === undefined) {
      if (taskDue || pendingOccurrenceDue) {
        this.lastError = 'task_scheduler_starter_missing';
      }
      return;
    }
    let claim: ReturnType<TaskRepository['claimDueScheduledOccurrence']> = null;
    let agentStartSucceeded = false;
    try {
      claim = this.repository.claimDueScheduledOccurrence({
        claimOwner: this.claimOwner,
        now,
        taskId: task.id
      });
      if (claim === null) {
        const refreshedTask = this.repository.findBackgroundTask(task.id);
        if (refreshedTask !== null) {
          this.registerTask(refreshedTask);
        }
        return;
      }
      this.scheduleOccurrenceReconcile();
      const result = await this.options.startRun({
        ...claim.request,
        dispatchKey: claim.dispatchKey
      });
      agentStartSucceeded = true;
      const updated = this.repository.markScheduledOccurrenceDispatched({
        attempt: claim.attempt,
        claimOwner: claim.claimOwner,
        dispatchedAt: new Date().toISOString(),
        occurrenceKey: claim.occurrenceKey,
        runId: result.runId
      });
      if (updated === null) {
        this.lastError = 'scheduled_occurrence_dispatch_claim_lost';
        this.scheduleOccurrenceReconcile();
        return;
      }
      this.repository.reconcileScheduledOccurrences({ now: new Date().toISOString() });
      this.scheduleOccurrenceReconcile();
      const reconciledTask = this.repository.findBackgroundTask(updated.id);
      if (reconciledTask !== null) {
        this.registerTask(reconciledTask);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (claim !== null && !agentStartSucceeded) {
        const updated = this.repository.recordScheduledOccurrenceStartFailure({
          attempt: claim.attempt,
          claimOwner: claim.claimOwner,
          failedAt: new Date().toISOString(),
          occurrenceKey: claim.occurrenceKey,
          reason: 'agent_start_failed'
        });
        if (updated === null) {
          this.lastError = 'scheduled_occurrence_start_failure_claim_lost';
          this.scheduleOccurrenceReconcile();
          return;
        }
        this.registerTask(updated);
        this.scheduleOccurrenceReconcile();
      }
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
    if (this.occurrenceReconcileTimer !== null) {
      clearTimeout(this.occurrenceReconcileTimer);
      this.occurrenceReconcileTimer = null;
    }
  }

  private scheduleOccurrenceReconcile(): void {
    if (this.occurrenceReconcileTimer !== null) {
      clearTimeout(this.occurrenceReconcileTimer);
      this.occurrenceReconcileTimer = null;
    }
    if (!this.running || this.suspended) {
      return;
    }
    const claimExpiresAt = this.repository.nextScheduledOccurrenceClaimExpiry();
    if (claimExpiresAt === null) {
      return;
    }
    const delay = Math.max(0, Date.parse(claimExpiresAt) - Date.now());
    const timer = setTimeout(() => {
      this.occurrenceReconcileTimer = null;
      this.reconcile();
    }, Math.min(delay, this.maxTimeoutDelayMs));
    timer.unref();
    this.occurrenceReconcileTimer = timer;
  }
}
