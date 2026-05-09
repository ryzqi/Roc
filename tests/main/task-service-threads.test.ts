import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { RocDomainError } from '../../src/main/services/errors';
import type { EnabledCapabilities, TaskRun } from '../../src/shared/types';

type TaskServiceThreadLifecycleApi = AppServices['taskService'] & {
  createTaskRun(input: {
    userInput: string;
    modelId: string;
    enabledCapabilities: EnabledCapabilities;
    threadId?: string;
  }): TaskRun;
  archiveThread(threadId: string): { deleted: true; threadId: string };
};

const emptyCapabilities: EnabledCapabilities = {
  mcpServers: [],
  skills: []
};

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-task-service-threads-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('TaskService thread lifecycle', () => {
  it('appends a run to an existing thread instead of creating a new one', () => {
    const taskService = services.taskService as TaskServiceThreadLifecycleApi;
    const firstRun = taskService.createTaskRun({
      userInput: '第一轮输入',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });

    const secondRun = taskService.createTaskRun({
      threadId: firstRun.threadId,
      userInput: '第二轮输入',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });

    const snapshot = services.taskService.getSnapshot();
    const messageEvents = snapshot.recentEvents
      .filter((event) => event.threadId === firstRun.threadId && event.type === 'message')
      .map((event) => (event.payload as { content: string }).content);

    expect(secondRun.threadId).toBe(firstRun.threadId);
    expect(secondRun.runNumber).toBe(2);
    expect(snapshot.threads).toHaveLength(1);
    expect(messageEvents).toEqual(expect.arrayContaining(['第一轮输入', '第二轮输入']));
  });

  it('archives a thread without deleting its runs or events', () => {
    const taskService = services.taskService as TaskServiceThreadLifecycleApi;
    const run = taskService.createTaskRun({
      userInput: '需要归档的会话',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });

    const deleted = taskService.archiveThread(run.threadId);
    const snapshot = services.taskService.getSnapshot();
    const threadRow = services.databaseService.db
      .prepare('SELECT archived_at FROM task_threads WHERE id = ?')
      .get(run.threadId) as { archived_at: string | null } | undefined;
    const runCountRow = services.databaseService.db
      .prepare('SELECT COUNT(*) AS count FROM task_runs WHERE thread_id = ?')
      .get(run.threadId) as { count: number };
    const eventCountRow = services.databaseService.db
      .prepare('SELECT COUNT(*) AS count FROM task_events WHERE thread_id = ?')
      .get(run.threadId) as { count: number };

    expect(deleted).toEqual({
      deleted: true,
      threadId: run.threadId
    });
    expect(snapshot.threads).toEqual([]);
    expect(threadRow?.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(runCountRow.count).toBe(1);
    expect(eventCountRow.count).toBe(1);
  });

  it('throws a clear not found error when archiving an unknown thread', () => {
    const taskService = services.taskService as TaskServiceThreadLifecycleApi;

    expect(() => taskService.archiveThread('thread_missing')).toThrow(RocDomainError);
    expect(() => taskService.archiveThread('thread_missing')).toThrow('任务会话不存在。');
  });
});
