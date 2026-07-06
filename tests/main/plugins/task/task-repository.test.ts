import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryReader } from '../../../../src/main/plugins/task/agent-task-history';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import type { BackgroundTaskPreviewRequest, EnabledCapabilities } from '../../../../src/shared/types';

let db: Database.Database;
let agentDb: Database.Database;

const enabledCapabilities: EnabledCapabilities = {
  mcpServers: ['filesystem'],
  skills: ['planning']
};

const manualPreviewRequest: BackgroundTaskPreviewRequest = {
  goal: 'Review the workspace every morning',
  trigger: {
    type: 'manual',
    description: 'Run when requested'
  },
  workspacePath: 'F:\\Code\\Roc',
  allowedActions: [],
  forbiddenActions: [],
  failurePolicy: 'pause_and_report',
  notificationPolicy: 'failures_and_confirmations',
  enabledCapabilities
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb);
});

afterEach(() => {
  db.close();
  agentDb.close();
});

describe('TaskRepository', () => {
  it('creates proposal run requests from description input and background-task workflow hint', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();

    expect(
      repository.createBackgroundTaskProposalRequest({
        description: 'Create a daily review task',
        enabledCapabilities
      })
    ).toEqual({
      input: 'Create a daily review task',
      mode: 'task',
      enabledCapabilities,
      workflowHint: 'propose_background_task'
    });
  });

  it('writes and reads current background task rows', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();

    const preview = repository.createBackgroundTaskPreview(manualPreviewRequest);
    const task = repository.createBackgroundTask(preview);

    expect(task).toMatchObject({
      goal: 'Review the workspace every morning',
      scheduled: false,
      status: 'running',
      triggerType: 'manual'
    });
    expect(repository.findBackgroundTask(task.id)).toEqual(task);
    expect(rawRow('background_tasks', task.id)).toMatchObject({
      enabled_capabilities_json: JSON.stringify(enabledCapabilities),
      scheduled: 0,
      status: 'running',
      trigger_type: 'manual'
    });
    expect(columnNames('background_tasks')).toContain('thread_id');
    expect(tableNames()).not.toContain('task_threads');
    expect(tableNames()).not.toContain('task_runs');
    expect(tableNames()).not.toContain('task_events');
  });

  it('rejects non-positive scheduled run limits before querying sqlite', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();
    const task = repository.createBackgroundTask(repository.createBackgroundTaskPreview(manualPreviewRequest));

    expect(() => repository.listScheduledRuns({ taskId: task.id, limit: 0 })).toThrow('scheduled_runs_limit_invalid');
    expect(() => repository.listScheduledRuns({ taskId: task.id, limit: -1 })).toThrow('scheduled_runs_limit_invalid');
  });

  it('preserves current background task status names across lifecycle mutations', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();
    const task = repository.createBackgroundTask(repository.createBackgroundTaskPreview(manualPreviewRequest));

    expect(repository.pauseBackgroundTask(task.id).status).toBe('paused');
    expect(repository.resumeBackgroundTask(task.id).status).toBe('running');
    expect(repository.cancelBackgroundTask(task.id).status).toBe('cancelled');
    expect(repository.deleteBackgroundTask(task.id)).toEqual({
      deleted: true,
      taskId: task.id
    });
    expect(repository.findBackgroundTask(task.id)?.status).toBe('archived');
  });
});

function rawRow(tableName: string, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as Record<string, unknown>;
}

function createRepository(): TaskRepository {
  return new TaskRepository(db, new AgentTaskHistoryReader(agentDb));
}

function columnNames(tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function tableNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));
}
