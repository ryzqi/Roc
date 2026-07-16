import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskScheduler } from '../../../../src/main/plugins/task/scheduler';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryReader } from '../../../../src/main/plugins/task/agent-task-history';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import { ThreadDeletionJournal } from '../../../../src/main/plugins/task/thread-deletion-journal';

let db: Database.Database;
let agentDb: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb);
  applyTaskPluginSchema(db);
});

afterEach(() => {
  vi.useRealTimers();
  agentDb.close();
  db.close();
});

describe('TaskScheduler', () => {
  it('loads scheduled background tasks from plugin tables and reports scheduler status', () => {
    const repository = createRepository();
    const nextRunAt = new Date(Date.now() + 60_000).toISOString();
    const task = repository.createBackgroundTask({
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
    });
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
    const repository = createRepository();
    const nextRunAt = new Date(Date.now() + 1_000).toISOString();
    const task = repository.createBackgroundTask({
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
    });
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
        taskSource: 'background_schedule',
        threadId: task.threadId,
        workspacePath: task.workspacePath
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

  it('reschedules future tasks when the maximum timeout slice elapses before nextRunAt', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-05T00:00:00.000Z') });
    const repository = createRepository();
    const nextRunAt = new Date(Date.now() + 10_000).toISOString();
    const task = repository.createBackgroundTask({
      goal: 'Run later without early firing',
      trigger: {
        type: 'once',
        description: 'Ten seconds from now',
        nextRunAt
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const startRequests: unknown[] = [];
    const scheduler = new TaskScheduler(repository, {
      maxTimeoutDelayMs: 1_000,
      startRun: async (request) => {
        startRequests.push(request);
        return {
          runId: 'run_scheduled_later',
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

    expect(startRequests).toEqual([]);
    expect(repository.listScheduledRuns({ taskId: task.id })).toEqual([]);
    expect(scheduler.getStatus().nextFireAt).toBe(nextRunAt);

    await vi.advanceTimersByTimeAsync(9_000);

    expect(startRequests).toEqual([
      expect.objectContaining({
        input: task.goal,
        mode: 'task',
        taskSource: 'background_schedule',
        workspacePath: task.workspacePath
      })
    ]);
  });

  it('records and pauses scheduled tasks when agent startup fails', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-05T00:00:00.000Z') });
    const repository = createRepository();
    const nextRunAt = new Date(Date.now() + 1_000).toISOString();
    const task = repository.createBackgroundTask({
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
    });
    const scheduler = new TaskScheduler(repository, {
      startRun: async () => {
        throw new Error('provider_unavailable');
      }
    });

    scheduler.start();
    scheduler.registerAllFromDatabase();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(scheduler.getStatus().lastError).toBe('provider_unavailable');
    expect(repository.listScheduledRuns({ taskId: task.id })).toContainEqual(
      expect.objectContaining({
        backgroundTaskId: task.id,
        taskRunId: null,
        scheduledAt: nextRunAt,
        status: 'failed',
        skipReason: 'agent_start_failed'
      })
    );
    expect(repository.findBackgroundTask(task.id)).toMatchObject({
      status: 'paused',
      lastRunStatus: 'failed'
    });
  });

  it('never registers or fires a journaled scheduled task', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-10T00:00:00.000Z') });
    const repository = createRepository();
    const task = repository.createBackgroundTask({
      goal: 'Do not fire while deletion is pending',
      trigger: {
        type: 'once',
        description: 'One second from now',
        nextRunAt: '2026-07-10T00:00:01.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    new ThreadDeletionJournal(db).ensurePending(task.threadId);
    const startRun = vi.fn();
    const scheduler = new TaskScheduler(repository, { startRun });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(scheduler.getStatus().registeredTaskCount).toBe(0);
    expect(startRun).not.toHaveBeenCalled();
  });
});

function createRepository(): TaskRepository {
  return new TaskRepository(db, new AgentTaskHistoryReader(agentDb));
}
