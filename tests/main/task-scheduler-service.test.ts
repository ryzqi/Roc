import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { TaskSchedulerService } from '../../src/main/services/task-scheduler-service';
import type { BackgroundTask, ChatStartRunRequest, ChatStartRunResult } from '../../src/shared/types';

type RunRequestRecord = ChatStartRunRequest & { createdRunId: string };

let root: string;
let services: AppServices;
let runRequests: RunRequestRecord[];

function createScheduler(maxRegisteredTasks = 256): TaskSchedulerService {
  let runIndex = 0;
  return new TaskSchedulerService(
    services.taskService,
    {
      startRun: async (request: ChatStartRunRequest): Promise<ChatStartRunResult> => {
        runIndex += 1;
        const runId = `run-fired-${runIndex}`;
        runRequests.push({ ...request, createdRunId: runId });
        return {
          runId,
          mode: request.mode,
          threadId: request.threadId ?? null,
          providerId: 'test-provider',
          modelId: 'test-model',
          createdAt: new Date().toISOString()
        };
      }
    },
    {
      maxRegisteredTasks,
      capabilityResolver: {
        resolveCurrentEnabledCapabilities: () => ({ mcpServers: [], skills: [] })
      }
    }
  );
}

function createBackgroundTask(input: {
  goal?: string;
  nextRunAt: string;
  trigger?: BackgroundTask['triggerType'];
  cronExpression?: string | null;
  workspacePath?: string;
}): BackgroundTask {
  const trigger =
    input.trigger === 'once'
      ? {
          type: 'once' as const,
          description: '一次性触发',
          nextRunAt: input.nextRunAt
        }
      : {
          type: 'cron' as const,
          description: '每分钟触发',
          cronExpression: input.cronExpression ?? '* * * * *',
          nextRunAt: input.nextRunAt
        };
  const preview = services.taskService.createBackgroundTaskPreview({
    goal: input.goal ?? '后台调度测试任务',
    trigger,
    workspacePath: input.workspacePath ?? root,
    allowedActions: ['pnpm test'],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations'
  });

  return services.taskService.createBackgroundTask(preview);
}

function scheduledRows(): Array<{ status: string; task_run_id: string | null; skip_reason: string | null }> {
  return services.databaseService.db
    .prepare('SELECT status, task_run_id, skip_reason FROM scheduled_task_runs ORDER BY scheduled_at ASC, rowid ASC')
    .all() as Array<{ status: string; task_run_id: string | null; skip_reason: string | null }>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-21T10:00:00.000Z'));
  root = mkdtempSync(join(tmpdir(), 'roc-task-scheduler-'));
  services = createAppServices(root);
  services.appService.initializeCritical();
  runRequests = [];
});

afterEach(() => {
  services.taskSchedulerService.stop();
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('TaskSchedulerService', () => {
  it('fires a due once task, records the scheduled run, and completes the schedule definition', async () => {
    const task = createBackgroundTask({
      trigger: 'once',
      nextRunAt: '2026-05-21T10:00:30.000Z'
    });
    const scheduler = createScheduler();

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);

    const updated = services.taskService.listBackgroundTasks()[0];
    expect(runRequests).toEqual([
      expect.objectContaining({
        input: task.goal,
        mode: 'task',
        threadId: task.threadId,
        createdRunId: 'run-fired-1'
      })
    ]);
    expect(scheduledRows()).toEqual([
      {
        status: 'fired',
        task_run_id: 'run-fired-1',
        skip_reason: null
      }
    ]);
    expect(updated).toEqual(
      expect.objectContaining({
        id: task.id,
        status: 'completed',
        nextRunAt: null,
        runCount: 1
      })
    );
    expect(scheduler.getStatus().registeredTaskCount).toBe(0);
  });

  it('suspends timers and resumes with next run based on current time', async () => {
    createBackgroundTask({
      nextRunAt: '2026-05-21T10:00:30.000Z'
    });
    const scheduler = createScheduler();

    scheduler.start();
    scheduler.suspendAll();
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.resumeAll();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(runRequests).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(runRequests).toHaveLength(1);
    expect(scheduler.getStatus().registeredTaskCount).toBe(1);
  });

  it('skips overdue startup runs with pause_and_report instead of backfilling them', () => {
    const task = createBackgroundTask({
      nextRunAt: '2026-05-21T09:30:00.000Z'
    });
    const scheduler = createScheduler();

    scheduler.start();

    const updated = services.taskService.listBackgroundTasks()[0];
    expect(runRequests).toEqual([]);
    expect(scheduledRows()).toEqual([
      {
        status: 'skipped',
        task_run_id: null,
        skip_reason: 'missed_startup'
      }
    ]);
    expect(updated).toEqual(
      expect.objectContaining({
        id: task.id,
        status: 'paused'
      })
    );
  });

  it('uses resume catch-up for missed runs after system sleep', () => {
    createBackgroundTask({
      nextRunAt: '2026-05-21T10:10:00.000Z'
    });
    const scheduler = createScheduler();

    scheduler.start();
    vi.setSystemTime(new Date('2026-05-21T11:00:00.000Z'));
    scheduler.handlePowerResume();

    expect(runRequests).toEqual([]);
    expect(scheduledRows()).toEqual([
      {
        status: 'skipped',
        task_run_id: null,
        skip_reason: 'missed_resume'
      }
    ]);
  });

  it('protects against concurrent firing of the same task', async () => {
    const task = createBackgroundTask({
      trigger: 'once',
      nextRunAt: '2026-05-21T10:00:30.000Z'
    });
    const scheduler = createScheduler();

    await Promise.all([scheduler.fire(task.id), scheduler.fire(task.id)]);

    expect(runRequests).toHaveLength(1);
    expect(scheduledRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'fired', task_run_id: 'run-fired-1' }),
        expect.objectContaining({ status: 'skipped', skip_reason: 'already_running' })
      ])
    );
  });

  it('rejects registration beyond the configured task limit', () => {
    createBackgroundTask({ nextRunAt: '2026-05-21T10:01:00.000Z' });
    createBackgroundTask({ nextRunAt: '2026-05-21T10:02:00.000Z' });
    const scheduler = createScheduler(1);

    try {
      scheduler.start();
      throw new Error('Expected scheduler limit to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(Reflect.get(error as object, 'code')).toBe('scheduler_resource_exhausted');
    }
  });
});
