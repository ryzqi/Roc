import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskScheduler } from '../../../../src/main/plugins/task/scheduler';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyTaskPluginSchema(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('TaskScheduler', () => {
  it('loads scheduled background tasks from plugin tables and reports scheduler status', () => {
    const repository = new TaskRepository(db);
    const nextRunAt = new Date(Date.now() + 60_000).toISOString();
    const task = repository.createBackgroundTask(
      repository.createBackgroundTaskPreview({
        goal: 'Run a scheduled check',
        trigger: {
          type: 'once',
          description: 'One minute from now',
          nextRunAt
        },
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );
    repository.recordScheduledTaskRun({
      backgroundTaskId: task.id,
      scheduledAt: nextRunAt,
      status: 'skipped',
      skipReason: 'missed_startup'
    });
    const scheduler = new TaskScheduler(repository);

    scheduler.start();
    scheduler.registerAllFromDatabase();

    expect(scheduler.getStatus()).toEqual({
      running: true,
      registeredTaskCount: 1,
      nextFireAt: nextRunAt,
      recentSkippedCount: 1,
      lastError: null
    });
  });

  it('fires due scheduled background tasks through the agent capability starter', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-05T00:00:00.000Z') });
    const repository = new TaskRepository(db);
    const nextRunAt = new Date(Date.now() + 1_000).toISOString();
    const task = repository.createBackgroundTask(
      repository.createBackgroundTaskPreview({
        goal: 'Run an automatic scheduled check',
        trigger: {
          type: 'once',
          description: 'One second from now',
          nextRunAt
        },
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );
    const startRequests: unknown[] = [];
    const scheduler = new TaskScheduler(repository, {
      startRun: async (request) => {
        startRequests.push(request);
        return {
          runId: 'run_scheduled_1',
          mode: 'task',
          threadId: request.threadId ?? null,
          providerId: 'smoke-provider',
          modelId: 'smoke-model',
          createdAt: new Date().toISOString()
        };
      }
    });

    scheduler.start();
    scheduler.registerAllFromDatabase();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(startRequests).toEqual([
      expect.objectContaining({
        input: task.goal,
        mode: 'task',
        threadId: task.threadId
      })
    ]);
    expect(repository.listScheduledRuns({ taskId: task.id })).toContainEqual(
      expect.objectContaining({
        backgroundTaskId: task.id,
        taskRunId: 'run_scheduled_1',
        scheduledAt: nextRunAt,
        status: 'fired'
      })
    );
  });
});
