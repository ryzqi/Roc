import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryReader } from '../../../../src/main/plugins/task/agent-task-history';
import { TaskScheduler } from '../../../../src/main/plugins/task/scheduler';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';

let agentDb: Database.Database;
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyTaskPluginSchema(db);
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb);
  vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
  agentDb.close();
  db.close();
});

describe('TaskScheduler crash consistency characterization', () => {
  it('starts the agent before it records the task run link or updates the task projection', async () => {
    const repository = new TaskRepository(db, new AgentTaskHistoryReader(agentDb));
    const task = repository.createBackgroundTask({
      goal: 'Run a due background task',
      trigger: {
        type: 'once',
        description: 'One second from now',
        nextRunAt: '2026-07-15T00:00:01.000Z'
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const calls: string[] = [];
    const originalRecordScheduledRun = repository.recordScheduledTaskRun.bind(repository);
    vi.spyOn(repository, 'recordScheduledTaskRun').mockImplementation((input) => {
      calls.push('record_scheduled_run');
      return originalRecordScheduledRun(input);
    });
    const originalMarkTaskFired = repository.markBackgroundTaskFired.bind(repository);
    vi.spyOn(repository, 'markBackgroundTaskFired').mockImplementation((input) => {
      calls.push('mark_task_fired');
      return originalMarkTaskFired(input);
    });
    const scheduler = new TaskScheduler(repository, {
      startRun: async () => {
        calls.push('start_agent');
        expect(repository.listScheduledRuns({ taskId: task.id })).toEqual([]);
        return {
          runId: 'run_scheduler_crash_gap',
          mode: 'task',
          threadId: task.threadId,
          providerId: 'test-provider',
          modelId: 'test-model',
          createdAt: new Date().toISOString()
        };
      }
    });

    scheduler.start();
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['start_agent', 'record_scheduled_run', 'mark_task_fired']);
    expect(repository.listScheduledRuns({ taskId: task.id })).toContainEqual(
      expect.objectContaining({
        status: 'fired',
        taskRunId: 'run_scheduler_crash_gap'
      })
    );
  });
});
