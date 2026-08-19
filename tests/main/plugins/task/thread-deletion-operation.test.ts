import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentDatabaseSchema, applyTaskDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import { ThreadDeletionJournal } from '../../../../src/main/plugins/task/thread-deletion-journal';

let agentDb: Database.Database;
let taskDb: Database.Database;

beforeEach(() => {
  agentDb = new Database(':memory:');
  taskDb = new Database(':memory:');
  applyAgentDatabaseSchema(agentDb);
  applyTaskDatabaseSchema(taskDb);
});

afterEach(() => {
  taskDb.close();
  agentDb.close();
});

describe('ThreadDeletionJournal operation', () => {
  it('deletes agent history and task projection through one journal entry', async () => {
    const agentHistory = new AgentTaskHistoryContract(agentDb);
    const onDeletionStarted = vi.fn(async () => {});
    const onDeletionCompleted = vi.fn(async () => {});
    const journal = new ThreadDeletionJournal({
      agentHistory,
      db: taskDb,
      lifecycle: {
        onDeletionCompleted,
        onDeletionStarted,
        onRecoveryFailed: () => {}
      }
    });
    const repository = new TaskRepository(taskDb, agentHistory, journal);
    const task = repository.createBackgroundTask(createPreview());

    await expect(journal.deleteThread(task.threadId)).resolves.toEqual({ deleted: true, threadId: task.threadId });

    expect(agentDb.prepare('SELECT COUNT(*) FROM agent_threads').pluck().get()).toBe(0);
    expect(taskDb.prepare('SELECT COUNT(*) FROM background_tasks').pluck().get()).toBe(0);
    expect(journal.require(task.threadId).state).toBe('complete');
    expect(onDeletionStarted).toHaveBeenCalledWith({ linkedTaskIds: [task.id], threadId: task.threadId });
    expect(onDeletionCompleted).toHaveBeenCalledWith({ linkedTaskIds: [task.id], threadId: task.threadId });
  });

  it('recovers task projection deletion from the durable agent-deleted state', async () => {
    const agentHistory = new AgentTaskHistoryContract(agentDb);
    const onDeletionStarted = vi.fn(async () => {});
    const onDeletionCompleted = vi.fn(async () => {});
    const onRecoveryFailed = vi.fn();
    const journal = new ThreadDeletionJournal({
      agentHistory,
      db: taskDb,
      lifecycle: {
        onDeletionCompleted,
        onDeletionStarted,
        onRecoveryFailed
      }
    });
    const repository = new TaskRepository(taskDb, agentHistory, journal);
    const task = repository.createBackgroundTask(createPreview());
    journal.ensurePending(task.threadId);
    agentHistory.deleteThread(task.threadId);
    journal.markAgentDeleted(task.threadId);

    await expect(journal.recoverIncomplete()).resolves.toBeUndefined();

    expect(taskDb.prepare('SELECT COUNT(*) FROM background_tasks').pluck().get()).toBe(0);
    expect(journal.require(task.threadId).state).toBe('complete');
    expect(onDeletionStarted).toHaveBeenCalledWith({ linkedTaskIds: [task.id], threadId: task.threadId });
    expect(onDeletionCompleted).toHaveBeenCalledWith({ linkedTaskIds: [task.id], threadId: task.threadId });
    expect(onRecoveryFailed).not.toHaveBeenCalled();
  });
});

function createPreview() {
  return {
    goal: 'Delete this background task thread',
    trigger: {
      type: 'once' as const,
      description: 'Run once',
      nextRunAt: '2026-08-20T00:00:00.000Z'
    },
    workspacePath: 'F:\\Code\\Roc',
    allowedActions: [],
    forbiddenActions: [],
    notificationPolicy: 'failures_and_confirmations' as const,
    enabledCapabilities: { mcpServers: [], skills: [] },
    failurePolicy: 'pause_and_report' as const
  };
}
