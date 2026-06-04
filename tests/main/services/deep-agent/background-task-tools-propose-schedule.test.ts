import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServices, type AppServices } from '../../../../src/main/services/app-service';
import { createBackgroundTaskTools } from '../../../../src/main/services/deep-agent/background-task-tools';
import { PreviewStore, RocToolResolutionError } from '../../../../src/main/services/forge-guardrails';
import type { BackgroundTaskPreview } from '../../../../src/shared/types';
import { minimalProposeToolInput } from '../../../_factories/background-task';

let root: string;
let services: AppServices;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
  root = mkdtempSync(join(tmpdir(), 'roc-background-task-propose-schedule-'));
  services = createAppServices(root);
  services.appService.initializeCritical();
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('background task propose/schedule tools', () => {
  function createPreview(): BackgroundTaskPreview {
    return services.taskService.createBackgroundTaskPreview({
      goal: '每小时检查测试状态',
      trigger: {
        type: 'cron',
        description: '每小时触发',
        cronExpression: '0 * * * *',
        nextRunAt: '2026-05-25T13:00:00.000Z'
      },
      workspacePath: root,
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      enabledCapabilities: null
    });
  }

  it('propose 仅生成 preview，不创建 DB 记录或注册调度器', async () => {
    const previewStore = new PreviewStore();
    const tools = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      previewStore
    });
    const propose = tools.find((tool) => tool.name === 'propose_background_task');

    expect(propose).toBeDefined();
    const result = JSON.parse(
      await propose!.invoke(
        minimalProposeToolInput({
          goal: '手动检查测试状态',
          trigger: {
            type: 'manual',
            description: '手动触发'
          },
          workspacePath: root
        })
      )
    ) as { previewId: string; preview: BackgroundTaskPreview };

    expect(result.previewId).toMatch(/^preview_/);
    expect(result.preview).toMatchObject({
      goal: '手动检查测试状态',
      trigger: {
        type: 'manual',
        description: '手动触发'
      },
      workspacePath: root,
      requiresConfirmation: false
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([]);
    expect(services.taskSchedulerService.getStatus().registeredTaskCount).toBe(0);
    expect(previewStore.size()).toBe(1);
  });

  it('schedule 用 previewId 一次性创建任务并注册调度器', async () => {
    const previewStore = new PreviewStore();
    const preview = createPreview();
    const previewId = previewStore.generatePreviewId();
    previewStore.put(previewId, preview);
    services.taskSchedulerService.start();
    const tools = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      previewStore
    });
    const schedule = tools.find((tool) => tool.name === 'schedule_background_task');

    expect(schedule).toBeDefined();
    const result = JSON.parse(await schedule!.invoke({ previewId })) as {
      ok: boolean;
      taskId: string;
      threadId: string;
      scheduledNextRunAt: string | null;
    };

    expect(result).toMatchObject({
      ok: true,
      taskId: expect.stringMatching(/^background_/),
      threadId: expect.stringMatching(/^thread_/),
      scheduledNextRunAt: '2026-05-25T13:00:00.000Z'
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: result.taskId,
        goal: preview.goal,
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        nextRunAt: '2026-05-25T13:00:00.000Z'
      })
    ]);
    expect(services.taskSchedulerService.getStatus().registeredTaskCount).toBe(1);
    expect(previewStore.size()).toBe(0);
  });

  it('schedule 对未知 previewId 抛 RocToolResolutionError', async () => {
    const previewStore = new PreviewStore();
    const tools = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      previewStore
    });
    const schedule = tools.find((tool) => tool.name === 'schedule_background_task');

    expect(schedule).toBeDefined();
    await expect(schedule!.invoke({ previewId: 'preview_unknown' })).rejects.toThrow(RocToolResolutionError);
    expect(services.taskService.listBackgroundTasks()).toEqual([]);
  });
});
