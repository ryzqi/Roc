import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-active-tasks-'));
  services = createAppServices(root);
  services.appService.initializeCritical();
});

afterEach(() => {
  services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('TaskService active task projection', () => {
  it('projects background tasks into the active task list', () => {
    const background = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '每天检查测试状态',
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

    const activeTasks = services.taskService.getActiveTasks();

    expect(activeTasks).toEqual([
      expect.objectContaining({
        kind: 'background',
        threadId: background.threadId,
        taskId: background.id,
        goal: '每天检查测试状态',
        trigger: {
          type: 'cron',
          description: '每天 09:00',
          cronExpression: '0 9 * * *',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        nextRunAt: '2026-05-22T01:00:00.000Z',
        workspacePath: root
      })
    ]);
  });

  it('excludes legacy background tasks whose thread was already archived', () => {
    const background = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '旧数据里的孤儿后台任务',
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
    services.databaseService.db
      .prepare('UPDATE task_threads SET status = ?, archived_at = ? WHERE id = ?')
      .run('archived', '2026-05-21T00:00:00.000Z', background.threadId);

    expect(services.taskService.getActiveTasks()).toEqual([]);
    expect(services.taskService.listBackgroundTasks()).toEqual([]);
    expect(services.taskService.listSchedulableBackgroundTasks()).toEqual([]);
    expect(services.taskService.getBackgroundTaskSummary()).toEqual({
      total: 0,
      running: 0,
      failed: 0,
      pendingConfirmation: 0,
      nextRunAt: null
    });
  });

  it('returns task details and scheduled run history for a background task', () => {
    const background = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '生成日报',
        trigger: {
          type: 'once',
          description: '明早一次',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );
    const scheduled = services.taskService.recordScheduledTaskRun({
      backgroundTaskId: background.id,
      scheduledAt: '2026-05-22T01:00:00.000Z',
      triggeredAt: '2026-05-22T01:00:03.000Z',
      status: 'fired',
      taskRunId: 'run-fired'
    });

    const detail = services.taskService.getTaskDetail({
      taskId: background.id,
      schedulerRegistered: true
    });
    const runs = services.taskService.listScheduledRuns({
      taskId: background.id,
      limit: 5
    });

    expect(detail).toMatchObject({
      threadId: background.threadId,
      taskId: background.id,
      lastRunId: background.runId,
      schedulerRegistered: true,
      backgroundTask: expect.objectContaining({
        id: background.id,
        goal: '生成日报'
      }),
      thread: expect.objectContaining({
        id: background.threadId,
        kind: 'background'
      })
    });
    expect(detail.runHistory).toEqual([
      expect.objectContaining({
        id: background.runId,
        threadId: background.threadId
      })
    ]);
    expect(detail.recentEvents).toEqual([
      expect.objectContaining({
        type: 'background_task_created'
      })
    ]);
    expect(runs).toEqual([scheduled]);
  });

  it('projects the latest running task run status over the recurring background task schedule status', () => {
    const background = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '每小时检查测试状态',
        trigger: {
          type: 'cron',
          description: '每小时',
          cronExpression: '0 * * * *',
          nextRunAt: '2026-05-22T02:00:00.000Z'
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );
    const run = services.taskService.createTaskRun({
      threadId: background.threadId,
      userInput: background.goal,
      modelId: 'model-ready',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    services.taskService.markRunRunning(run.id);
    services.taskService.markBackgroundTaskFired({
      taskId: background.id,
      runId: run.id,
      firedAt: '2026-05-22T01:00:00.000Z',
      nextRunAt: '2026-05-22T02:00:00.000Z'
    });

    const activeTasks = services.taskService.getActiveTasks();

    expect(activeTasks).toEqual([
      expect.objectContaining({
        taskId: background.id,
        status: 'running',
        nextRunAt: '2026-05-22T02:00:00.000Z',
        lastRunAt: '2026-05-22T01:00:00.000Z'
      })
    ]);
  });

  it('keeps a fired once background task visible as running until the task run finishes', () => {
    const background = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '一次性检查测试状态',
        trigger: {
          type: 'once',
          description: '一次触发',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );
    const run = services.taskService.createTaskRun({
      threadId: background.threadId,
      userInput: background.goal,
      modelId: 'model-ready',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    services.taskService.markRunRunning(run.id);
    services.taskService.markBackgroundTaskFired({
      taskId: background.id,
      runId: run.id,
      firedAt: '2026-05-22T01:00:00.000Z',
      nextRunAt: null
    });

    const activeTasks = services.taskService.getActiveTasks();

    expect(activeTasks).toEqual([
      expect.objectContaining({
        taskId: background.id,
        status: 'running',
        nextRunAt: null,
        lastRunAt: '2026-05-22T01:00:00.000Z'
      })
    ]);
  });

  it('updates background task last run status when the fired task run completes', () => {
    const background = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '一次性完成测试',
        trigger: {
          type: 'once',
          description: '一次触发',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );
    const run = services.taskService.createTaskRun({
      threadId: background.threadId,
      userInput: background.goal,
      modelId: 'model-ready',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    services.taskService.markBackgroundTaskFired({
      taskId: background.id,
      runId: run.id,
      firedAt: '2026-05-22T01:00:00.000Z',
      nextRunAt: null
    });

    services.taskService.completeRunWithProviderResult({
      runId: run.id,
      result: {
        providerId: 'provider-ready',
        modelId: 'model-ready',
        createdAt: '2026-05-22T01:00:00.000Z',
        durationMs: 1000,
        assistantMessage: '完成',
        summary: '完成',
        finishReason: 'stop',
        usage: {
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          promptCharacters: 0,
          completionCharacters: 0
        }
      }
    });

    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: background.id,
        status: 'completed',
        lastRunStatus: 'success'
      })
    ]);
  });

  it('marks the background task failed when the fired task run fails', () => {
    const background = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '一次性失败测试',
        trigger: {
          type: 'once',
          description: '一次触发',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );
    const run = services.taskService.createTaskRun({
      threadId: background.threadId,
      userInput: background.goal,
      modelId: 'model-ready',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    services.taskService.markBackgroundTaskFired({
      taskId: background.id,
      runId: run.id,
      firedAt: '2026-05-22T01:00:00.000Z',
      nextRunAt: null
    });

    services.taskService.failRunWithProviderError({
      runId: run.id,
      providerId: 'provider-ready',
      modelId: 'model-ready',
      code: 'provider_error',
      message: '模型调用失败',
      retryable: true,
      suggestion: '重试'
    });

    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: background.id,
        status: 'failed',
        lastRunStatus: 'failed'
      })
    ]);
  });
});
