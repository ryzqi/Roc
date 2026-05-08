import { describe, expect, it } from 'vitest';
import type { BackgroundTask, TaskThread } from '../../src/shared/types';
import { buildHistoryItems } from '../../src/renderer/history-sidebar';

function createThread(id: string, title: string): TaskThread {
  return {
    id,
    title,
    goal: title,
    status: 'completed',
    createdAt: '2026-05-08T15:00:00.000Z',
    updatedAt: '2026-05-08T15:30:45.000Z'
  };
}

function createBackgroundTask(threadId: string): BackgroundTask {
  return {
    id: `background-${threadId}`,
    threadId,
    runId: `run-${threadId}`,
    goal: '后台定时任务',
    status: 'running',
    scheduled: true,
    triggerDescription: 'schedule',
    nextRunAt: '2026-05-08T16:00:00.000Z',
    workspacePath: 'F:\\Code\\Roc',
    allowedActions: ['pnpm test'],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    riskLevel: 'low',
    requiresConfirmation: false,
    createdAt: '2026-05-08T15:00:00.000Z',
    updatedAt: '2026-05-08T15:30:45.000Z'
  };
}

describe('history sidebar helpers', () => {
  it('keeps only user conversation threads in the history list', () => {
    const items = buildHistoryItems([
      createThread('user-thread', '用户真实任务'),
      createThread('quick-thread', '快捷入口创建任务'),
      createThread('current-thread', '当前主会话'),
      createThread('tray-thread', '托盘接管记录'),
      createThread('memory-thread', '记忆整理裁决'),
      createThread('task-thread', '任务工作台记录'),
      createThread('background-thread', '后台定时任务')
    ], [createBackgroundTask('background-thread')]);

    expect(items).toEqual([
      {
        id: 'user-thread',
        label: '用户真实任务',
        meta: '2026-05-08 15:30',
        icon: 'history'
      }
    ]);
  });
});
