import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';

let taskDb: Database.Database;
let agentDb: Database.Database;

beforeEach(() => {
  taskDb = new Database(':memory:');
  taskDb.pragma('foreign_keys = ON');
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb);
  applyTaskPluginSchema(taskDb);
});

afterEach(() => {
  agentDb.close();
  taskDb.close();
});

describe('scheduled occurrence repository', () => {
  it('claims one due occurrence with a deterministic dispatch key and immutable task request', () => {
    const repository = createRepository();
    const scheduledAt = '2026-07-17T00:00:00.000Z';
    const task = createDueTask(repository, scheduledAt);

    const claim = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });

    expect(claim).toMatchObject({
      occurrenceKey: `${task.id}:${scheduledAt}:1`,
      dispatchKey: `${task.id}:${scheduledAt}:1`,
      taskId: task.id,
      taskRevision: 1,
      scheduledAt,
      request: {
        enabledCapabilities: { mcpServers: [], skills: [] },
        input: task.goal,
        mode: 'task',
        taskSource: 'background_schedule',
        threadId: task.threadId,
        workspacePath: task.workspacePath
      }
    });
    expect(
      repository.claimDueScheduledOccurrence({
        claimOwner: 'scheduler-b',
        now: '2026-07-17T00:00:01.000Z',
        taskId: task.id
      })
    ).toBeNull();
    expect(repository.findBackgroundTask(task.id)?.nextRunAt).toBeNull();
  });

  it('increments the task revision without changing an already claimed occurrence snapshot', () => {
    const repository = createRepository();
    const scheduledAt = '2026-07-17T00:00:00.000Z';
    const task = createDueTask(repository, scheduledAt, 'cron');
    const claim = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });
    if (claim === null) {
      throw new Error('scheduled_occurrence_claim_missing');
    }

    repository.updateBackgroundTask({
      patch: { goal: 'Use the revised task definition' },
      reason: 'User changed the task goal',
      taskId: task.id
    });

    expect(taskDb.prepare('SELECT task_revision FROM background_tasks WHERE id = ?').get(task.id)).toEqual({
      task_revision: 2
    });
    expect(
      taskDb
        .prepare('SELECT request_json FROM scheduled_occurrences WHERE occurrence_key = ?')
        .get(claim.occurrenceKey)
    ).toEqual({
      request_json: JSON.stringify(claim.request)
    });
  });

  it('coalesces a cron misfire to only its latest due occurrence', () => {
    const repository = createRepository();
    const task = createDueTask(repository, '2026-07-17T00:00:00.000Z', 'cron');

    const claim = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:11:00.000Z',
      taskId: task.id
    });

    expect(claim).toMatchObject({
      scheduledAt: '2026-07-17T00:10:00.000Z'
    });
    expect(repository.findBackgroundTask(task.id)?.nextRunAt).toBe('2026-07-17T00:15:00.000Z');
    expect(
      taskDb.prepare('SELECT reason FROM scheduled_occurrences WHERE background_task_id = ?').all(task.id)
    ).toEqual([{ reason: 'misfire_coalesced_latest' }]);
  });

  it('keeps the latest overlapping occurrence pending until the previous occurrence is terminal', () => {
    const repository = createRepository();
    const task = createDueTask(repository, '2026-07-17T00:00:00.000Z', 'cron');
    const first = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });
    if (first === null) {
      throw new Error('first_scheduled_occurrence_claim_missing');
    }
    repository.markScheduledOccurrenceDispatched({
      attempt: first.attempt,
      claimOwner: first.claimOwner,
      dispatchedAt: '2026-07-17T00:00:02.000Z',
      occurrenceKey: first.occurrenceKey,
      runId: 'run_active_occurrence'
    });

    expect(
      repository.claimDueScheduledOccurrence({
        claimOwner: 'scheduler-a',
        now: '2026-07-17T00:05:01.000Z',
        taskId: task.id
      })
    ).toBeNull();
    expect(
      taskDb
        .prepare('SELECT scheduled_at, status, reason FROM scheduled_occurrences WHERE background_task_id = ? ORDER BY scheduled_at')
        .all(task.id)
    ).toEqual([
      { scheduled_at: '2026-07-17T00:00:00.000Z', status: 'dispatched', reason: null },
      { scheduled_at: '2026-07-17T00:05:00.000Z', status: 'pending', reason: 'overlap_coalesced_latest' }
    ]);
    expect(repository.listScheduledRuns({ taskId: task.id })).toContainEqual(
      expect.objectContaining({
        scheduledAt: '2026-07-17T00:05:00.000Z',
        skipReason: 'overlap_coalesced_latest',
        status: 'pending',
        taskRunId: null
      })
    );

    taskDb
      .prepare("UPDATE scheduled_occurrences SET status = 'completed', terminal_at = ? WHERE occurrence_key = ?")
      .run('2026-07-17T00:05:02.000Z', first.occurrenceKey);

    expect(
      repository.claimDueScheduledOccurrence({
        claimOwner: 'scheduler-a',
        now: '2026-07-17T00:05:03.000Z',
        taskId: task.id
      })
    ).toMatchObject({ scheduledAt: '2026-07-17T00:05:00.000Z' });
  });

  it('replaces an older pending overlap with the latest due cron occurrence', () => {
    const repository = createRepository();
    const task = createDueTask(repository, '2026-07-17T00:00:00.000Z', 'cron');
    const first = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });
    if (first === null) {
      throw new Error('first_scheduled_occurrence_claim_missing');
    }
    repository.markScheduledOccurrenceDispatched({
      attempt: first.attempt,
      claimOwner: first.claimOwner,
      dispatchedAt: '2026-07-17T00:00:02.000Z',
      occurrenceKey: first.occurrenceKey,
      runId: 'run_active_occurrence'
    });

    expect(
      repository.claimDueScheduledOccurrence({
        claimOwner: 'scheduler-a',
        now: '2026-07-17T00:05:01.000Z',
        taskId: task.id
      })
    ).toBeNull();
    expect(
      repository.claimDueScheduledOccurrence({
        claimOwner: 'scheduler-a',
        now: '2026-07-17T00:10:01.000Z',
        taskId: task.id
      })
    ).toBeNull();

    expect(
      taskDb
        .prepare('SELECT scheduled_at, status, reason FROM scheduled_occurrences WHERE background_task_id = ? ORDER BY scheduled_at')
        .all(task.id)
    ).toEqual([
      { scheduled_at: '2026-07-17T00:00:00.000Z', status: 'dispatched', reason: null },
      { scheduled_at: '2026-07-17T00:05:00.000Z', status: 'skipped', reason: 'overlap_coalesced_superseded' },
      { scheduled_at: '2026-07-17T00:10:00.000Z', status: 'pending', reason: 'overlap_coalesced_latest' }
    ]);
    expect(repository.findBackgroundTask(task.id)?.nextRunAt).toBe('2026-07-17T00:15:00.000Z');
  });

  it('releases expired claims for a restart-safe re-claim', () => {
    const repository = createRepository();
    const task = createDueTask(repository, '2026-07-17T00:00:00.000Z');
    const first = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:00.000Z',
      taskId: task.id
    });
    if (first === null) {
      throw new Error('first_scheduled_occurrence_claim_missing');
    }

    repository.reconcileScheduledOccurrences({ now: '2026-07-17T00:01:01.000Z' });

    expect(
      repository.claimDueScheduledOccurrence({
        claimOwner: 'scheduler-b',
        now: '2026-07-17T00:01:01.000Z',
        taskId: task.id
      })
    ).toMatchObject({ occurrenceKey: first.occurrenceKey });
  });

  it('rejects stale claim owners from dispatching or failing a re-claimed occurrence', () => {
    const repository = createRepository();
    const task = createDueTask(repository, '2026-07-17T00:00:00.000Z');
    const first = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:00.000Z',
      taskId: task.id
    });
    if (first === null) {
      throw new Error('first_scheduled_occurrence_claim_missing');
    }
    repository.reconcileScheduledOccurrences({ now: '2026-07-17T00:01:01.000Z' });
    const second = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-b',
      now: '2026-07-17T00:01:01.000Z',
      taskId: task.id
    });
    if (second === null) {
      throw new Error('second_scheduled_occurrence_claim_missing');
    }

    expect(
      repository.markScheduledOccurrenceDispatched({
        attempt: first.attempt,
        claimOwner: first.claimOwner,
        dispatchedAt: '2026-07-17T00:01:02.000Z',
        occurrenceKey: first.occurrenceKey,
        runId: 'run_stale_owner'
      })
    ).toBeNull();
    expect(
      repository.recordScheduledOccurrenceStartFailure({
        attempt: first.attempt,
        claimOwner: first.claimOwner,
        failedAt: '2026-07-17T00:01:02.000Z',
        occurrenceKey: first.occurrenceKey,
        reason: 'agent_start_failed'
      })
    ).toBeNull();
    expect(repository.findBackgroundTask(task.id)?.status).toBe('running');

    repository.markScheduledOccurrenceDispatched({
      attempt: second.attempt,
      claimOwner: second.claimOwner,
      dispatchedAt: '2026-07-17T00:01:03.000Z',
      occurrenceKey: second.occurrenceKey,
      runId: 'run_current_owner'
    });
    expect(
      taskDb.prepare('SELECT status, run_id FROM scheduled_occurrences WHERE occurrence_key = ?').get(second.occurrenceKey)
    ).toEqual({ status: 'dispatched', run_id: 'run_current_owner' });
  });

  it('skips pending occurrences from the prior revision when a task is updated', () => {
    const repository = createRepository();
    const task = createDueTask(repository, '2026-07-17T00:00:00.000Z', 'cron');
    const first = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });
    if (first === null) {
      throw new Error('first_scheduled_occurrence_claim_missing');
    }
    repository.markScheduledOccurrenceDispatched({
      attempt: first.attempt,
      claimOwner: first.claimOwner,
      dispatchedAt: '2026-07-17T00:00:02.000Z',
      occurrenceKey: first.occurrenceKey,
      runId: 'run_active_occurrence'
    });
    repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:05:01.000Z',
      taskId: task.id
    });

    repository.updateBackgroundTask({
      patch: { goal: 'Use the revision-two task definition' },
      reason: 'Revise the task',
      taskId: task.id
    });

    expect(
      taskDb
        .prepare("SELECT status, reason FROM scheduled_occurrences WHERE scheduled_at = '2026-07-17T00:05:00.000Z'")
        .get()
    ).toEqual({ status: 'skipped', reason: 'superseded_by_task_revision' });
  });

  it('reconciles a dispatched occurrence from the durable agent run terminal state', () => {
    const repository = createRepository();
    const task = createDueTask(repository, '2026-07-17T00:00:00.000Z');
    const claim = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });
    if (claim === null) {
      throw new Error('scheduled_occurrence_claim_missing');
    }
    repository.markScheduledOccurrenceDispatched({
      attempt: claim.attempt,
      claimOwner: claim.claimOwner,
      dispatchedAt: '2026-07-17T00:00:02.000Z',
      occurrenceKey: claim.occurrenceKey,
      runId: task.runId
    });
    agentDb.prepare('UPDATE agent_runs SET status = ?, ended_at = ? WHERE id = ?').run(
      'completed',
      '2026-07-17T00:01:00.000Z',
      task.runId
    );

    repository.reconcileScheduledOccurrences({ now: '2026-07-17T00:01:01.000Z' });

    expect(
      taskDb.prepare('SELECT status, terminal_at FROM scheduled_occurrences WHERE occurrence_key = ?').get(claim.occurrenceKey)
    ).toEqual({ status: 'completed', terminal_at: '2026-07-17T00:01:01.000Z' });
    expect(repository.findBackgroundTask(task.id)).toMatchObject({ lastRunStatus: 'success' });
  });

  it('marks a dispatched occurrence unknown when its agent run was interrupted', () => {
    const repository = createRepository();
    const task = createDueTask(repository, '2026-07-17T00:00:00.000Z');
    const claim = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });
    if (claim === null) {
      throw new Error('scheduled_occurrence_claim_missing');
    }
    repository.markScheduledOccurrenceDispatched({
      attempt: claim.attempt,
      claimOwner: claim.claimOwner,
      dispatchedAt: '2026-07-17T00:00:02.000Z',
      occurrenceKey: claim.occurrenceKey,
      runId: task.runId
    });
    agentDb.prepare('UPDATE agent_runs SET status = ?, ended_at = ? WHERE id = ?').run(
      'interrupted',
      '2026-07-17T00:01:00.000Z',
      task.runId
    );

    repository.reconcileScheduledOccurrences({ now: '2026-07-17T00:01:01.000Z' });

    expect(
      taskDb.prepare('SELECT status, reason FROM scheduled_occurrences WHERE occurrence_key = ?').get(claim.occurrenceKey)
    ).toEqual({ status: 'unknown', reason: 'agent_run_interrupted' });
  });

  it('rejects linking the same agent run to two occurrences', () => {
    const repository = createRepository();
    const firstTask = createDueTask(repository, '2026-07-17T00:00:00.000Z');
    const secondTask = createDueTask(repository, '2026-07-17T00:00:00.000Z');
    const first = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: firstTask.id
    });
    const second = repository.claimDueScheduledOccurrence({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: secondTask.id
    });
    if (first === null || second === null) {
      throw new Error('scheduled_occurrence_claim_missing');
    }
    repository.markScheduledOccurrenceDispatched({
      attempt: first.attempt,
      claimOwner: first.claimOwner,
      dispatchedAt: '2026-07-17T00:00:02.000Z',
      occurrenceKey: first.occurrenceKey,
      runId: 'run_shared_occurrence'
    });

    expect(() =>
      repository.markScheduledOccurrenceDispatched({
        attempt: second.attempt,
        claimOwner: second.claimOwner,
        dispatchedAt: '2026-07-17T00:00:03.000Z',
        occurrenceKey: second.occurrenceKey,
        runId: 'run_shared_occurrence'
      })
    ).toThrow('scheduled_occurrence_dispatch_run_conflict');
  });

  it('reclaims the persisted occurrence after task and agent databases restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-scheduled-occurrence-'));
    const taskPath = join(root, 'task.db');
    const agentPath = join(root, 'agent.db');
    let firstTaskDb: Database.Database | null = null;
    let firstAgentDb: Database.Database | null = null;
    let restartedTaskDb: Database.Database | null = null;
    let restartedAgentDb: Database.Database | null = null;
    try {
      firstTaskDb = new Database(taskPath);
      firstTaskDb.pragma('foreign_keys = ON');
      firstAgentDb = new Database(agentPath);
      firstAgentDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(firstTaskDb);
      applyAgentDatabaseSchema(firstAgentDb);
      const firstRepository = new TaskRepository(firstTaskDb, new AgentTaskHistoryContract(firstAgentDb));
      const task = firstRepository.createBackgroundTask({
        goal: 'Reclaim after restart',
        trigger: {
          description: 'Already due',
          nextRunAt: '2026-07-17T00:00:00.000Z',
          type: 'once'
        },
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      });
      const firstClaim = firstRepository.claimDueScheduledOccurrence({
        claimOwner: 'before-restart',
        now: '2026-07-17T00:00:00.000Z',
        taskId: task.id
      });
      if (firstClaim === null) {
        throw new Error('scheduled_occurrence_initial_claim_missing');
      }
      firstTaskDb.close();
      firstTaskDb = null;
      firstAgentDb.close();
      firstAgentDb = null;

      restartedTaskDb = new Database(taskPath);
      restartedTaskDb.pragma('foreign_keys = ON');
      restartedAgentDb = new Database(agentPath);
      restartedAgentDb.pragma('foreign_keys = ON');
      applyTaskPluginSchema(restartedTaskDb);
      applyAgentDatabaseSchema(restartedAgentDb);
      const restartedRepository = new TaskRepository(restartedTaskDb, new AgentTaskHistoryContract(restartedAgentDb));
      restartedRepository.reconcileScheduledOccurrences({ now: '2026-07-17T00:01:01.000Z' });

      expect(
        restartedRepository.claimDueScheduledOccurrence({
          claimOwner: 'after-restart',
          now: '2026-07-17T00:01:01.000Z',
          taskId: task.id
        })
      ).toMatchObject({ occurrenceKey: firstClaim.occurrenceKey });
    } finally {
      restartedAgentDb?.close();
      restartedTaskDb?.close();
      firstAgentDb?.close();
      firstTaskDb?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function createRepository(): TaskRepository {
  return new TaskRepository(taskDb, new AgentTaskHistoryContract(agentDb));
}

function createDueTask(repository: TaskRepository, scheduledAt: string, triggerType: 'cron' | 'once' = 'once') {
  return repository.createBackgroundTask({
    goal: 'Inspect the scheduled workspace',
    trigger: triggerType === 'cron'
      ? {
          cronExpression: '*/5 * * * *',
          description: 'At the recorded time',
          nextRunAt: scheduledAt,
          type: 'cron'
        }
      : {
          description: 'At the recorded time',
          nextRunAt: scheduledAt,
          type: 'once'
        },
    workspacePath: 'F:\\Code\\Roc',
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations'
  });
}
