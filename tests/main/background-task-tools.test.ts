import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyBackgroundTaskToolDecision,
  createBackgroundTaskTools
} from '../../src/main/services/deep-agent/background-task-tools';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { RocDomainError } from '../../src/main/services/errors';
import type { ChatResumeDecision } from '../../src/shared/types';
import { invalidProposeInput, minimalProposeToolInput, validProposeInput } from '../_factories/background-task';

let root: string;
let services: AppServices;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
  root = mkdtempSync(join(tmpdir(), 'roc-background-task-tools-'));
  services = createAppServices(root);
  services.appService.initializeCritical();
});

afterEach(() => {
  services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('background task deep-agent tools', () => {
  function futureOnceRunAt(): string {
    return new Date(Date.now() + 60_000).toISOString();
  }

  it('creates a cron task from minimal model-authored input and injects runtime defaults', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    const result = JSON.parse(
      await propose.invoke({
        goal: '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件',
        trigger: {
          type: 'cron',
          description: '每天晚上 7:40 触发',
          cronExpression: '40 19 * * *',
          nextRunAt: '2026-05-26T11:40:00.000Z'
        },
        workspacePath: root
      })
    ) as { taskId: string };

    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: result.taskId,
        allowedActions: [],
        forbiddenActions: [],
        notificationPolicy: 'failures_and_confirmations',
        enabledCapabilities: null,
        cronExpression: '40 19 * * *',
        nextRunAt: '2026-05-26T11:40:00.000Z'
      })
    ]);
  });

  it('creates and registers a daily 21:50 cron task with the canonical trigger schema', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });
    services.taskSchedulerService.start();
    const input = validProposeInput({
      goal: '每天晚上9点抓取AI的最新新闻，然后写到当前目录下的docx文件记录',
      trigger: {
        type: 'cron',
        description: '每天晚上21:50触发',
        cronExpression: '50 21 * * *',
        nextRunAt: futureOnceRunAt()
      },
      workspacePath: root
    });

    const result = JSON.parse(
      await propose.invoke(
        minimalProposeToolInput({
          goal: input.goal,
          trigger: input.trigger,
          workspacePath: input.workspacePath
        })
      )
    ) as { ok: boolean; taskId: string; scheduledNextRunAt: string | null };

    expect(result).toMatchObject({
      ok: true,
      taskId: expect.stringMatching(/^background_/),
      scheduledNextRunAt: input.trigger.type === 'cron' ? input.trigger.nextRunAt : null
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: result.taskId,
        goal: '每天晚上9点抓取AI的最新新闻，然后写到当前目录下的docx文件记录',
        triggerType: 'cron',
        cronExpression: '50 21 * * *',
        notificationPolicy: 'failures_and_confirmations'
      })
    ]);
    expect(services.taskSchedulerService.getStatus().registeredTaskCount).toBe(1);
  });

  it('rejects trigger.schedule payloads at the tool schema boundary without creating a task', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    expect(invalidProposeInput('trigger.schedule')).toBeRejectedByProposeSchemaAtPath('trigger');
    await expect(propose.invoke(invalidProposeInput('trigger.schedule'))).rejects.toThrow(/trigger/i);

    expect(services.taskService.listBackgroundTasks()).toEqual([]);
  });

  it('rejects cron expr aliases without normalizing them into cronExpression', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    expect(invalidProposeInput('trigger.expr')).toBeRejectedByProposeSchemaAtPath('trigger');
    await expect(propose.invoke(invalidProposeInput('trigger.expr'))).rejects.toThrow(/trigger/i);

    expect(services.taskService.listBackgroundTasks()).toEqual([]);
  });

  it('rejects notificationPolicy on_error without creating a task', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    expect(invalidProposeInput('notification-on-error')).toBeRejectedByProposeSchemaAtPath('notificationPolicy');
    await expect(propose.invoke(invalidProposeInput('notification-on-error'))).rejects.toThrow(/notificationPolicy/i);

    expect(services.taskService.listBackgroundTasks()).toEqual([]);
  });

  it('rejects runtime-only top-level fields at the model-visible schema boundary', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    await expect(
      propose.invoke({
        goal: '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件',
        trigger: {
          type: 'cron',
          description: '每天晚上 7:40 触发',
          cronExpression: '40 19 * * *',
          nextRunAt: '2026-05-26T11:40:00.000Z'
        },
        workspacePath: root,
        notificationPolicy: 'default'
      })
    ).rejects.toThrow(/notificationPolicy/i);

    expect(services.taskService.listBackgroundTasks()).toEqual([]);
  });

  it('creates a manual background task immediately when propose_background_task is invoked', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    const result = JSON.parse(
      await propose.invoke(minimalProposeToolInput({
        goal: '手动检查测试状态',
        trigger: {
          type: 'manual',
          description: '手动触发'
        },
        workspacePath: root
      }))
    ) as {
      ok: boolean;
      taskId: string;
      threadId: string;
      scheduledNextRunAt: string | null;
    };

    expect(result).toMatchObject({
      ok: true,
      taskId: expect.stringMatching(/^background_/),
      threadId: expect.stringMatching(/^thread_/),
      scheduledNextRunAt: null
    });
    expect(result).not.toHaveProperty('requiredFields');
    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: result.taskId,
        threadId: result.threadId,
        goal: '手动检查测试状态',
        triggerType: 'manual',
        scheduled: false,
        nextRunAt: null,
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      })
    ]);
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
        workspacePath: root
      })
    ).rejects.toMatchObject({
      code: 'background_task_cron_invalid'
    });
  });

  it('enabledCapabilities 未传 -> 创建的任务字段为 null', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });

    const output = JSON.parse(
      await propose.invoke(minimalProposeToolInput({
        goal: '每天 9 点提醒',
        trigger: {
          type: 'cron',
          description: 'daily 9am',
          cronExpression: '0 9 * * *',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root
      }))
    ) as { taskId: string };

    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: output.taskId,
        enabledCapabilities: null
      })
    ]);
  });

  it('enabledCapabilities 通过 runtime 依赖注入 -> 创建的任务字段透传', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService,
      enabledCapabilities: { mcpServers: ['github'], skills: [] }
    });

    const output = JSON.parse(
      await propose.invoke(minimalProposeToolInput({
        goal: '每天 9 点提醒',
        trigger: {
          type: 'cron',
          description: 'daily 9am',
          cronExpression: '0 9 * * *',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        workspacePath: root
      }))
    ) as { taskId: string };

    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: output.taskId,
        enabledCapabilities: { mcpServers: ['github'], skills: [] }
      })
    ]);
  });

  it('creates and registers a once scheduled task immediately', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });
    services.taskSchedulerService.start();
    const nextRunAt = futureOnceRunAt();
    const result = JSON.parse(
      await propose.invoke(minimalProposeToolInput({
        goal: '1 分钟后检查测试',
        trigger: {
          type: 'once',
          description: '一分钟后',
          nextRunAt
        },
        workspacePath: root
      }))
    ) as { ok: boolean; taskId: string; threadId: string; scheduledNextRunAt: string | null };

    expect(result).toMatchObject({
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

  it('creates and registers a cron scheduled task immediately', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });
    services.taskSchedulerService.start();
    const nextRunAt = futureOnceRunAt();
    const result = JSON.parse(
      await propose.invoke(minimalProposeToolInput({
        goal: '每分钟检查测试',
        trigger: {
          type: 'cron',
          description: '每分钟',
          cronExpression: '* * * * *',
          nextRunAt
        },
        workspacePath: root
      }))
    ) as { ok: boolean; taskId: string; threadId: string; scheduledNextRunAt: string | null };

    expect(result).toMatchObject({
      ok: true,
      taskId: expect.stringMatching(/^background_/),
      scheduledNextRunAt: nextRunAt
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: result.taskId,
        goal: '每分钟检查测试',
        triggerType: 'cron',
        cronExpression: '* * * * *'
      })
    ]);
    expect(services.taskSchedulerService.getStatus().registeredTaskCount).toBe(1);
  });

  it('does not leave direct-created scheduled tasks pending confirmation when only forbidden actions are provided', async () => {
    const [propose] = createBackgroundTaskTools({
      taskService: services.taskService,
      schedulerService: services.taskSchedulerService
    });
    services.taskSchedulerService.start();
    const nextRunAt = futureOnceRunAt();
    const result = JSON.parse(
      await propose.invoke(minimalProposeToolInput({
        goal: '禁止发布但继续检查测试',
        trigger: {
          type: 'cron',
          description: '每分钟',
          cronExpression: '* * * * *',
          nextRunAt
        },
        workspacePath: root
      }))
    ) as { ok: boolean; taskId: string; scheduledNextRunAt: string | null };

    expect(result).toMatchObject({
      ok: true,
      taskId: expect.stringMatching(/^background_/),
      scheduledNextRunAt: nextRunAt
    });
    expect(services.taskService.listBackgroundTasks()).toEqual([
      expect.objectContaining({
        id: result.taskId,
        status: 'running',
        requiresConfirmation: false,
        triggerType: 'cron'
      })
    ]);
    expect(services.taskSchedulerService.getStatus().registeredTaskCount).toBe(1);
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

  it('throws when applying an edited update action to the wrong tool', () => {
    expect(() =>
      applyBackgroundTaskToolDecision({
        taskService: services.taskService,
        schedulerService: services.taskSchedulerService,
        actionName: 'update_background_task',
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
