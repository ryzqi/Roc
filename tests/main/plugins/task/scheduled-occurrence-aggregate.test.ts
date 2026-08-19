import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundTaskRepository } from '../../../../src/main/plugins/task/background-task-repository';
import { applyTaskDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ScheduledOccurrenceRepository } from '../../../../src/main/plugins/task/scheduled-occurrence-repository';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyTaskDatabaseSchema(db);
});

afterEach(() => {
  db.close();
});

describe('scheduled occurrence aggregate', () => {
  it('releases an expired claim and permits a new owner to reclaim it', () => {
    const backgroundTasks = new BackgroundTaskRepository(db);
    const occurrences = new ScheduledOccurrenceRepository(db, backgroundTasks, {
      findRunStatus: () => null
    });
    const task = backgroundTasks.create({
      goal: 'Inspect the scheduled workspace',
      trigger: {
        type: 'once',
        description: 'At the recorded time',
        nextRunAt: '2026-07-17T00:00:00.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });

    const firstClaim = occurrences.claimDue({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });
    expect(firstClaim).toMatchObject({ attempt: 1, claimOwner: 'scheduler-a' });

    expect(occurrences.reconcile({ now: '2026-07-17T00:01:02.000Z' })).toEqual([]);
    expect(
      occurrences.claimDue({
        claimOwner: 'scheduler-b',
        now: '2026-07-17T00:01:02.000Z',
        taskId: task.id
      })
    ).toMatchObject({
      attempt: 2,
      claimOwner: 'scheduler-b',
      occurrenceKey: firstClaim?.occurrenceKey
    });
  });

  it('reconciles a dispatched failed run through the run reader and pauses its task', () => {
    const backgroundTasks = new BackgroundTaskRepository(db);
    const findRunStatus = vi.fn(() => 'failed' as const);
    const occurrences = new ScheduledOccurrenceRepository(db, backgroundTasks, { findRunStatus });
    const task = backgroundTasks.create({
      goal: 'Reconcile the dispatched workspace run',
      trigger: {
        type: 'once',
        description: 'At the recorded time',
        nextRunAt: '2026-07-17T00:00:00.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const claim = occurrences.claimDue({
      claimOwner: 'scheduler-a',
      now: '2026-07-17T00:00:01.000Z',
      taskId: task.id
    });
    if (claim === null) {
      throw new Error('scheduled_occurrence_claim_missing');
    }

    occurrences.markDispatched({
      attempt: claim.attempt,
      claimOwner: claim.claimOwner,
      dispatchedAt: '2026-07-17T00:00:02.000Z',
      occurrenceKey: claim.occurrenceKey,
      runId: 'run_dispatched_failure'
    });

    expect(occurrences.reconcile({ now: '2026-07-17T00:01:00.000Z' })).toMatchObject([
      { id: task.id, status: 'paused', lastRunStatus: 'failed' }
    ]);
    expect(findRunStatus).toHaveBeenCalledWith('run_dispatched_failure');
    expect(
      db.prepare('SELECT status, reason FROM scheduled_occurrences WHERE occurrence_key = ?').get(claim.occurrenceKey)
    ).toEqual({ status: 'failed', reason: 'agent_run_failed' });
    expect(backgroundTasks.find(task.id)).toMatchObject({ status: 'paused', lastRunStatus: 'failed' });
  });
});
