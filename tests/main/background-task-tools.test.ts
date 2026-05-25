import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBackgroundTaskToolDecision,
  createBackgroundTaskTools
} from '../../src/main/services/deep-agent/background-task-tools';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { RocDomainError } from '../../src/main/services/errors';
import type { ChatResumeDecision } from '../../src/shared/types';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-background-task-tools-'));
  services = createAppServices(root);
  services.appService.initializeCritical();
});

afterEach(() => {
  services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('background task deep-agent tools', () => {
  function futureOnceRunAt(): string {
    return new Date(Date.now() + 60_000).toISOString();
  }

  it('proposes a background task without writing a database row before approval', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    const result = JSON.parse(
      await propose.invoke({
        goal: '每天检查测试状态',
        trigger: {
          type: 'cron',
          description: '每天 09:00',
          cronExpression: '0 9 * * *',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: ['git push']
      })
    ) as {
      kind: string;
      preview: unknown;
      risk: string;
      requiredFields: string[];
    };

    expect(result).toMatchObject({
      kind: 'propose_background_task',
      risk: 'medium',
      requiredFields: ['decision'],
      preview: {
        goal: '每天检查测试状态',
        cronExpression: '0 9 * * *',
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      }
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([]);
  });

  it('rejects invalid cron expressions before approval', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    await expect(
      propose.invoke({
        goal: '坏 cron',
        trigger: {
          type: 'cron',
          description: '坏表达式',
          cronExpression: '0 9 * * * *',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: []
      })
    ).rejects.toMatchObject({
      code: 'background_task_cron_invalid'
    });
  });

  it('enabledCapabilities 未传 -> preview 字段为 null', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    const output = JSON.parse(
      await propose.invoke({
        goal: '每天 9 点提醒',
        trigger: {
          type: 'cron',
          description: 'daily 9am',
          cronExpression: '0 9 * * *',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root
      })
    ) as { preview: { enabledCapabilities: unknown } };

    expect(output.preview.enabledCapabilities).toBeNull();
  });

  it('enabledCapabilities 显式传入 -> preview 字段透传', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    const output = JSON.parse(
      await propose.invoke({
        goal: '每天 9 点提醒',
        trigger: {
          type: 'cron',
          description: 'daily 9am',
          cronExpression: '0 9 * * *',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root,
        enabledCapabilities: { mcpServers: ['github'], skills: [] }
      })
    ) as { preview: { enabledCapabilities: unknown } };

    expect(output.preview.enabledCapabilities).toEqual({ mcpServers: ['github'], skills: [] });
  });

  it('applies approve and registers the scheduled task', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });
    services.taskSchedulerService.start();
    const nextRunAt = futureOnceRunAt();
    const payload = JSON.parse(
      await propose.invoke({
        goal: '1 分钟后检查测试',
        trigger: {
          type: 'once',
          description: '一分钟后',
          nextRunAt
        },
        workspacePath: root,
        allowedActions: ['pnpm test'],
        forbiddenActions: []
      })
    ) as { preview: unknown };

    const applied = applyBackgroundTaskToolDecision({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      actionName: 'propose_background_task',
      actionArgs: payload.preview,
      decision: { type: 'approve' } as ChatResumeDecision
    });

    expect(applied).toMatchObject({
      ok: true,
      taskId: expect.stringMatching(/^background_/),
      scheduledNextRunAt: nextRunAt
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        goal: '1 分钟后检查测试',
        triggerType: 'once'
      })
    ]);
    expect(services.taskSchedulerService.getStatus().registeredTaskCount).toBe(1);
  });

  it('applies edited approval values before creating the task', async () => {
    const payload = services.taskService.createBackgroundTaskPreview({
      goal: '原始任务',
      trigger: {
        type: 'manual',
        description: '手动'
      },
      workspacePath: root,
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });

    applyBackgroundTaskToolDecision({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      actionName: 'propose_background_task',
      actionArgs: payload,
      decision: {
        type: 'edit',
        editedAction: {
          name: 'propose_background_task',
          args: {
            ...payload,
            goal: '编辑后的任务'
          }
        }
      } as ChatResumeDecision
    });

    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        goal: '编辑后的任务'
      })
    ]);
  });

  it('reject leaves the database unchanged', () => {
    const payload = services.taskService.createBackgroundTaskPreview({
      goal: '拒绝任务',
      trigger: {
        type: 'manual',
        description: '手动'
      },
      workspacePath: root,
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });

    const result = applyBackgroundTaskToolDecision({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      actionName: 'propose_background_task',
      actionArgs: payload,
      decision: { type: 'reject' } as ChatResumeDecision
    });

    expect(result).toEqual({
      ok: false,
      reason: 'rejected'
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([]);
  });

  it('updates cron definitions and re-registers the scheduler timer', () => {
    services.taskSchedulerService.start();
    const task = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '旧任务',
        trigger: {
          type: 'cron',
          description: '旧 cron',
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

    const result = applyBackgroundTaskToolDecision({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      actionName: 'update_background_task',
      actionArgs: {
        taskId: task.id,
        patch: {
          trigger: {
            type: 'cron',
            description: '新 cron',
            cronExpression: '*/15 * * * *',
            nextRunAt: '2026-05-22T01:15:00.000Z'
          }
        },
        reason: '改成每 15 分钟'
      },
      decision: { type: 'approve' } as ChatResumeDecision
    });

    expect(result).toMatchObject({
      ok: true,
      taskId: task.id
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: task.id,
        triggerDescription: '新 cron',
        cronExpression: '*/15 * * * *',
        nextRunAt: '2026-05-22T01:15:00.000Z'
      })
    ]);
    expect(services.taskSchedulerService.getStatus().registeredTaskCount).toBe(1);
  });

  it('cancels through the shared background task transition', () => {
    const task = services.taskService.createBackgroundTask(
      services.taskService.createBackgroundTaskPreview({
        goal: '取消任务',
        trigger: {
          type: 'manual',
          description: '手动'
        },
        workspacePath: root,
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    );

    const result = applyBackgroundTaskToolDecision({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      actionName: 'cancel_background_task',
      actionArgs: {
        taskId: task.id,
        reason: '用户取消'
      },
      decision: { type: 'approve' } as ChatResumeDecision
    });

    expect(result).toMatchObject({
      ok: true,
      taskId: task.id,
      status: 'cancelled'
    });
    expect(services.taskService.listBackgroundTasks()[0]).toEqual(
      expect.objectContaining({
        id: task.id,
        status: 'cancelled'
      })
    );
  });

  it('throws when applying an edited action to the wrong tool', () => {
    expect(() =>
      applyBackgroundTaskToolDecision({
        taskService: services.taskService,
        schedulerService: services.taskSchedulerService,
        actionName: 'propose_background_task',
        actionArgs: {},
        decision: {
          type: 'edit',
          editedAction: {
            name: 'cancel_background_task',
            args: {}
          }
        } as ChatResumeDecision
      })
    ).toThrow(RocDomainError);
  });
});
