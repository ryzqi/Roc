import { readFileSync } from 'node:fs';
import { wrapIpc } from '../../src/main/services/errors';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupAppServicesTest, initializeAppServicesTest, normalizeLineEndings, startFakeProvider, type AppServicesTestContext } from './app-service-fixtures';


describe('Roc foundation services tasks', () => {
  let context: AppServicesTestContext;

  beforeEach(() => {
    context = initializeAppServicesTest();
  });

  afterEach(() => {
    cleanupAppServicesTest(context);
  });

  it('creates scheduled background tasks and keeps tray summary bound to task state', () => {
    const preview = context.services.taskService.createBackgroundTaskPreview({
      goal: '每天检查项目测试状态',
      trigger: {
        type: 'cron',
        description: '每天 09:00',
        cronExpression: '0 9 * * *',
        nextRunAt: '2026-04-29T01:00:00.000Z'
      },
      workspacePath: context.root,
      allowedActions: ['pnpm test'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = context.services.taskService.createBackgroundTask(preview);
    const paused = context.services.taskService.pauseBackgroundTask(task.id);
    const resumed = context.services.taskService.resumeBackgroundTask(task.id);
    const tray = context.services.lifecycleService.getTraySummary();
    const snapshot = context.services.taskService.getSnapshot();

    expect(preview).toMatchObject({
      goal: '每天检查项目测试状态',
      scheduled: true,
      nextRunAt: '2026-04-29T01:00:00.000Z',
      cronExpression: '0 9 * * *',
      riskLevel: 'medium',
      requiresConfirmation: false
    });
    expect(task).toMatchObject({
      goal: '每天检查项目测试状态',
      status: 'running',
      triggerDescription: '每天 09:00',
      nextRunAt: '2026-04-29T01:00:00.000Z',
      cronExpression: '0 9 * * *',
      lastRunAt: null,
      lastRunStatus: null,
      runCount: 0
    });
    expect(paused.status).toBe('paused');
    expect(resumed.status).toBe('running');
    expect(tray).toMatchObject({
      residentEnabled: true,
      backgroundPaused: false,
      backgroundTasks: {
        total: 1,
        running: 1,
        failed: 0,
        pendingConfirmation: 0
      },
      nextRunAt: '2026-04-29T01:00:00.000Z'
    });
    expect(snapshot.counts.running).toBe(1);
    expect(snapshot.threads).toContainEqual(
      expect.objectContaining({
        id: task.threadId,
        status: 'running'
      })
    );
    expect(snapshot.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'background_task_created' }),
        expect.objectContaining({ type: 'background_task_paused' }),
        expect.objectContaining({ type: 'background_task_resumed' })
      ])
    );
  });

  it('returns structured errors for illegal background task transitions', async () => {
    const missing = await wrapIpc(() => context.services.taskService.pauseBackgroundTask('missing-background-task'));

    expect(missing).toEqual({
      ok: false,
      error: {
        code: 'background_task_not_found',
        message: '后台任务不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请刷新任务工作台后重试。'
      }
    });

    const preview = context.services.taskService.createBackgroundTaskPreview({
      goal: '检查取消状态',
      trigger: {
        type: 'manual',
        description: '手动触发'
      },
      workspacePath: context.root,
      allowedActions: ['pnpm test'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = context.services.taskService.createBackgroundTask(preview);
    context.services.taskService.cancelBackgroundTask(task.id);

    const resumeCancelled = await wrapIpc(() => context.services.taskService.resumeBackgroundTask(task.id));

    expect(resumeCancelled).toEqual({
      ok: false,
      error: {
        code: 'background_task_invalid_transition',
        message: '后台任务当前状态不能继续。',
        category: 'conflict',
        retryable: false,
        userAction: '请查看任务状态，必要时创建新的后台任务。'
      }
    });
  });

  it('stages background task edit context for the next chat turn and records a visible system message', () => {
    const preview = context.services.taskService.createBackgroundTaskPreview({
      goal: '修改每天检查项目测试状态',
      trigger: {
        type: 'cron',
        description: '每天 09:00',
        cronExpression: '0 9 * * *',
        nextRunAt: '2026-04-29T01:00:00.000Z'
      },
      workspacePath: context.root,
      allowedActions: ['pnpm test'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = context.services.taskService.createBackgroundTask(preview);

    const opened = context.services.taskService.openBackgroundTaskInChat(task.id);
    const messages = context.services.taskService.listThreadMessages(task.threadId);
    const firstContext = context.services.taskService.takePendingThreadContext(task.threadId);
    const secondContext = context.services.taskService.takePendingThreadContext(task.threadId);

    expect(opened).toEqual({
      threadId: task.threadId
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          payload: expect.objectContaining({
            role: 'assistant',
            content: expect.stringContaining(task.id)
          })
        })
      ])
    );
    expect(firstContext).toContain(task.id);
    expect(firstContext).toContain('"goal": "修改每天检查项目测试状态"');
    expect(firstContext).toContain('update_background_task');
    expect(secondContext).toBeNull();
  });

  it('generates redacted diagnostic packages with task, RTK and performance evidence', () => {
    for (let index = 0; index < 505; index += 1) {
      context.services.performanceObserverService.record({
        phase: 'db_query',
        label: `query-${index}`,
        startedAtMs: index,
        durationMs: 2,
        metadata: {
          index
        }
      });
    }
    const preview = context.services.taskService.createBackgroundTaskPreview({
      goal: '生成诊断包',
      trigger: {
        type: 'manual',
        description: '手动触发'
      },
      workspacePath: context.root,
      allowedActions: ['echo diagnostic'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = context.services.taskService.createBackgroundTask(preview);
    const pack = context.services.diagnosticsService.createDiagnosticPackage({
      taskId: task.id,
      errorSummary: 'Authorization: Bearer sk-secret-value'
    });
    const content = readFileSync(pack.path, 'utf8');

    expect(pack).toMatchObject({
      taskId: task.id,
      redacted: true,
      includes: expect.arrayContaining(['task_snapshot', 'performance_sample', 'rtk_status'])
    });
    expect(content).toContain('"timing"');
    expect(content).toContain('"label": "query-504"');
    expect(content).not.toContain('"label": "query-0"');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('sk-secret-value');
    expect(content).not.toContain('Bearer sk-secret-value');
  });
});
