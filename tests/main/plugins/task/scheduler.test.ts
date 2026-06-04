import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
