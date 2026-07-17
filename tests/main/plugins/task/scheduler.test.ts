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
    seedAgentRun('run_scheduled_1', task);
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
    expect(
      db.prepare(
        `SELECT background_task_id, run_id, scheduled_at, status
         FROM scheduled_occurrences
         WHERE background_task_id = ?`
      ).all(task.id)
    ).toEqual([
      {
        background_task_id: task.id,
        run_id: 'run_scheduled_1',
        scheduled_at: nextRunAt,
        status: 'dispatched'
      }
    ]);
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

  it('reclaims an expired occurrence lease during scheduler startup before dispatching it', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-05T00:01:01.000Z') });
    const repository = createRepository();
    const task = repository.createBackgroundTask({
      goal: 'Resume the claimed scheduled check',
      trigger: {
        type: 'once',
        description: 'Already due',
        nextRunAt: '2026-06-05T00:00:00.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const firstClaim = repository.claimDueScheduledOccurrence({
      claimOwner: 'previous-process',
      now: '2026-06-05T00:00:00.000Z',
      taskId: task.id
    });
    if (firstClaim === null) {
      throw new Error('scheduled_occurrence_initial_claim_missing');
    }
    seedAgentRun('run_reclaimed_occurrence', task);
    const startRun = vi.fn(async () => ({
      runId: 'run_reclaimed_occurrence',
      mode: 'task' as const,
      threadId: task.threadId,
      providerId: 'smoke-provider',
      modelId: 'smoke-model',
      createdAt: new Date().toISOString()
    }));
    const scheduler = new TaskScheduler(repository, { startRun });

    scheduler.start();
    await vi.runAllTimersAsync();

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKey: firstClaim.dispatchKey,
        taskSource: 'background_schedule'
      })
    );
    expect(
      db.prepare('SELECT status, run_id FROM scheduled_occurrences WHERE occurrence_key = ?').get(firstClaim.occurrenceKey)
    ).toEqual({ status: 'dispatched', run_id: 'run_reclaimed_occurrence' });
  });

  it('wakes at a claimed once occurrence lease expiry after restart', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-05T00:00:01.000Z') });
    const repository = createRepository();
    const task = repository.createBackgroundTask({
      goal: 'Resume a claim before its lease expires',
      trigger: {
        type: 'once',
        description: 'Already due',
        nextRunAt: '2026-06-05T00:00:00.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const claim = repository.claimDueScheduledOccurrence({
      claimOwner: 'previous-process',
      now: '2026-06-05T00:00:00.000Z',
      taskId: task.id
    });
    if (claim === null) {
      throw new Error('scheduled_occurrence_initial_claim_missing');
    }
    seedAgentRun('run_restart_claim_expiry', task);
    const startRun = vi.fn(async () => ({
      runId: 'run_restart_claim_expiry',
      mode: 'task' as const,
      threadId: task.threadId,
      providerId: 'smoke-provider',
      modelId: 'smoke-model',
      createdAt: new Date().toISOString()
    }));
    const scheduler = new TaskScheduler(repository, { startRun });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(58_999);
    expect(startRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKey: claim.dispatchKey,
        taskSource: 'background_schedule'
      })
    );
    expect(
      db.prepare('SELECT status, run_id FROM scheduled_occurrences WHERE occurrence_key = ?').get(claim.occurrenceKey)
    ).toEqual({ status: 'dispatched', run_id: 'run_restart_claim_expiry' });
  });

  it('marks an occurrence unknown instead of replaying an interrupted agent run after a claim/link crash', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-05T00:01:01.000Z') });
    const repository = createRepository();
    const task = repository.createBackgroundTask({
      goal: 'Do not replay an interrupted scheduled run',
      trigger: {
        type: 'once',
        description: 'Already due',
        nextRunAt: '2026-06-05T00:00:00.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const firstClaim = repository.claimDueScheduledOccurrence({
      claimOwner: 'previous-process',
      now: '2026-06-05T00:00:00.000Z',
      taskId: task.id
    });
    if (firstClaim === null) {
      throw new Error('scheduled_occurrence_initial_claim_missing');
    }
    agentDb.prepare('UPDATE agent_runs SET status = ?, ended_at = ? WHERE id = ?').run(
      'interrupted',
      '2026-06-05T00:01:00.000Z',
      task.runId
    );
    const startRun = vi.fn(async () => ({
      runId: task.runId,
      mode: 'task' as const,
      threadId: task.threadId,
      providerId: 'smoke-provider',
      modelId: 'smoke-model',
      createdAt: new Date().toISOString()
    }));
    const scheduler = new TaskScheduler(repository, { startRun });

    scheduler.start();
    await vi.runAllTimersAsync();

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(
      db.prepare('SELECT status, reason FROM scheduled_occurrences WHERE occurrence_key = ?').get(firstClaim.occurrenceKey)
    ).toEqual({ status: 'unknown', reason: 'agent_run_interrupted' });
  });

  it('coalesces missed cron times to the latest occurrence on power resume', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-05T23:59:00.000Z') });
    const repository = createRepository();
    const task = repository.createBackgroundTask({
      goal: 'Run only the latest missed cron occurrence',
      trigger: {
        type: 'cron',
        cronExpression: '*/5 * * * *',
        description: 'Every five minutes',
        nextRunAt: '2026-06-06T00:00:00.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const startRun = vi.fn(async () => ({
      runId: task.runId,
      mode: 'task' as const,
      threadId: task.threadId,
      providerId: 'smoke-provider',
      modelId: 'smoke-model',
      createdAt: new Date().toISOString()
    }));
    const scheduler = new TaskScheduler(repository, { startRun });

    scheduler.start();
    vi.setSystemTime(new Date('2026-06-06T00:11:00.000Z'));
    scheduler.handlePowerResume();
    await vi.advanceTimersByTimeAsync(0);

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(
      db.prepare('SELECT scheduled_at, reason FROM scheduled_occurrences WHERE background_task_id = ?').all(task.id)
    ).toEqual([{ scheduled_at: '2026-06-06T00:10:00.000Z', reason: 'misfire_coalesced_latest' }]);
    expect(repository.findBackgroundTask(task.id)?.nextRunAt).toBe('2026-06-06T00:15:00.000Z');
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
    expect(
      db.prepare(
        `SELECT run_id, scheduled_at, status, reason
         FROM scheduled_occurrences
         WHERE background_task_id = ?`
      ).all(task.id)
    ).toEqual([
      {
        run_id: null,
        scheduled_at: nextRunAt,
        status: 'failed',
        reason: 'agent_start_failed'
      }
    ]);
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

function seedAgentRun(runId: string, task: { createdAt: string; goal: string; threadId: string; workspacePath: string }): void {
  agentDb
    .prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, workspace_path, task_source, workflow_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      task.threadId,
      2,
      task.goal,
      'running',
      task.createdAt,
      null,
      null,
      null,
      JSON.stringify({ mcpServers: [], skills: [] }),
      task.workspacePath,
      'background_schedule',
      null
    );
}
