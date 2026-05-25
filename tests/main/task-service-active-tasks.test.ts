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
});
