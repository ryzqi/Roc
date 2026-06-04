import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { RocDomainError } from '../../src/main/services/errors';
import type { EnabledCapabilities, TaskEvent, TaskRun } from '../../src/shared/types';

type TaskServiceThreadLifecycleApi = AppServices['taskService'] & {
  createTaskRun(input: {
    userInput: string;
    modelId: string;
    enabledCapabilities: EnabledCapabilities;
    threadId?: string;
  }): TaskRun;
  archiveThread(threadId: string): { deleted: true; threadId: string };
  listThreadMessages(threadId: string): TaskEvent[];
  recordEvent(input: { threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }): TaskEvent;
  recordEvents(inputs: Array<{ threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }>): TaskEvent[];
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

afterEach(async () => {
  await services.appService.shutdown();
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

  it('lists complete thread messages even after recentEvents is saturated by streaming trace events', () => {
    const taskService = services.taskService as TaskServiceThreadLifecycleApi;
    const firstRun = taskService.createTaskRun({
      userInput: '第一轮输入',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });

    for (let index = 0; index < 60; index += 1) {
      taskService.recordEvent({
        threadId: firstRun.threadId,
        runId: firstRun.id,
        type: 'message_delta',
        payload: {
          role: 'assistant',
          delta: `chunk-${index}`
        }
      });
    }

    const secondRun = taskService.createTaskRun({
      threadId: firstRun.threadId,
      userInput: '第二轮输入',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });

    const snapshot = services.taskService.getSnapshot();
    const snapshotMessageContents = snapshot.recentEvents
      .filter((event) => event.threadId === firstRun.threadId && event.type === 'message')
      .map((event) => (event.payload as { content: string }).content);
    const threadMessageContents = taskService
      .listThreadMessages(firstRun.threadId)
      .map((event) => (event.payload as { content: string }).content);

    expect(secondRun.threadId).toBe(firstRun.threadId);
    expect(snapshotMessageContents).toEqual(['第二轮输入']);
    expect(threadMessageContents).toEqual(['第一轮输入', '第二轮输入']);
  });

  it('records multiple task events in insertion order with a shared timestamp', () => {
    const taskService = services.taskService as TaskServiceThreadLifecycleApi;
    const run = taskService.createTaskRun({
      userInput: '批量记录事件',
      modelId: 'model-alpha',
      enabledCapabilities: emptyCapabilities
    });

    const events = taskService.recordEvents([
      {
        threadId: run.threadId,
        runId: run.id,
        type: 'message_delta',
        payload: {
          role: 'assistant',
          delta: 'hello '
        }
      },
      {
        threadId: run.threadId,
        runId: run.id,
        type: 'message_delta',
        payload: {
          role: 'assistant',
          delta: 'world'
        }
      }
    ]);
    const rows = services.databaseService.db
      .prepare(
        `SELECT id, payload_json, created_at
         FROM task_events
         WHERE run_id = ? AND type = 'message_delta'
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(run.id) as Array<{ id: string; payload_json: string; created_at: string }>;

    expect(events.map((event) => (event.payload as { delta: string }).delta)).toEqual(['hello ', 'world']);
    expect(new Set(events.map((event) => event.createdAt)).size).toBe(1);
    expect(rows.map((row) => JSON.parse(row.payload_json) as { delta: string }).map((payload) => payload.delta)).toEqual([
      'hello ',
      'world'
    ]);
    expect(rows.map((row) => row.id)).toEqual(events.map((event) => event.id));
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

  it('archives linked background tasks when archiving their thread', () => {
    const background = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '需要随会话归档的后台任务',
        trigger: {
          type: 'cron',
          description: '每天 09:00',
          cronExpression: '0 9 * * *',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );

    services.taskService.archiveThread(background.threadId);

    const taskRow = services.databaseService.db
      .prepare('SELECT status FROM background_tasks WHERE id = ?')
      .get(background.id) as { status: string } | undefined;

    expect(taskRow?.status).toBe('archived');
    expect(services.taskService.getActiveTasks()).toEqual([]);
    expect(services.taskService.listBackgroundTasks()).toEqual([]);
  });

  it('throws a clear not found error when archiving an unknown thread', () => {
    const taskService = services.taskService as TaskServiceThreadLifecycleApi;

    expect(() => taskService.archiveThread('thread_missing')).toThrow(RocDomainError);
    expect(() => taskService.archiveThread('thread_missing')).toThrow('任务会话不存在。');
  });
});
