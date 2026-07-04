import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import type { BackgroundTaskPreviewRequest, EnabledCapabilities } from '../../../../src/shared/types';

let db: Database.Database;

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
});

afterEach(() => {
  db.close();
});

describe('TaskRepository', () => {
  it('creates proposal run requests from description input and background-task workflow hint', () => {
    applyTaskPluginSchema(db);
    const repository = new TaskRepository(db);

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
    const repository = new TaskRepository(db);

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
    expect(rawRow('task_threads', task.threadId)).toMatchObject({
      kind: 'background',
      status: 'running'
    });
  });

  it('rejects non-positive scheduled run limits before querying sqlite', () => {
    applyTaskPluginSchema(db);
    const repository = new TaskRepository(db);
    const task = repository.createBackgroundTask(repository.createBackgroundTaskPreview(manualPreviewRequest));

    expect(() => repository.listScheduledRuns({ taskId: task.id, limit: 0 })).toThrow('scheduled_runs_limit_invalid');
    expect(() => repository.listScheduledRuns({ taskId: task.id, limit: -1 })).toThrow('scheduled_runs_limit_invalid');
  });

  it('preserves current background task status names across lifecycle mutations', () => {
    applyTaskPluginSchema(db);
    const repository = new TaskRepository(db);
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
