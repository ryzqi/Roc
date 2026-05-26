import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActiveTaskItem, TaskDetail } from '../../src/shared/types';
import { TaskDetailDrawer } from '../../src/renderer/views/tasks/TaskDetailDrawer';

function createItem(status: ActiveTaskItem['status']): ActiveTaskItem {
  return {
    kind: 'background',
    threadId: 'thread-1',
    taskId: 'bg-1',
    title: '整理工作区变更',
    goal: '整理工作区变更',
    status,
    trigger: {
      type: 'cron',
      description: '每小时检查一次',
      cronExpression: '0 * * * *',
      nextRunAt: '2026-05-16T08:00:00.000Z'
    },
    nextRunAt: '2026-05-16T08:00:00.000Z',
    lastRunAt: null,
    riskLevel: 'medium',
    workspacePath: 'F:\\Code\\Roc',
    createdAt: '2026-05-16T07:00:00.000Z',
    updatedAt: '2026-05-16T07:05:00.000Z'
  };
}

function createDetail(status: ActiveTaskItem['status']): TaskDetail {
  return {
    threadId: 'thread-1',
    taskId: 'bg-1',
    lastRunId: 'run-1',
    schedulerRegistered: true,
    thread: {
      id: 'thread-1',
      kind: 'background',
      title: '整理工作区变更',
      goal: '整理工作区变更',
      status,
      createdAt: '2026-05-16T07:00:00.000Z',
      updatedAt: '2026-05-16T07:05:00.000Z'
    },
    backgroundTask: {
      id: 'bg-1',
      threadId: 'thread-1',
      runId: 'run-1',
      goal: '整理工作区变更',
      status,
      scheduled: true,
      triggerType: 'cron',
      triggerDescription: '每小时检查一次',
      nextRunAt: '2026-05-16T08:00:00.000Z',
      cronExpression: '0 * * * *',
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: ['pnpm test'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      riskLevel: 'medium',
      requiresConfirmation: true,
      lastRunAt: null,
      lastRunStatus: null,
      runCount: 0,
      createdAt: '2026-05-16T07:00:00.000Z',
      updatedAt: '2026-05-16T07:05:00.000Z',
      enabledCapabilities: null
    },
    runHistory: [],
    recentEvents: []
  };
}

describe('TaskDetailDrawer', () => {
  it('renders task settings details when the selected tab is switched on the server default layout', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailDrawer, {
        item: createItem('running'),
        detail: createDetail('running'),
        scheduledRuns: [],
        onCancel: () => {},
        onDelete: () => {},
        onOpenInChat: () => {},
        onOpenChat: () => {},
        onPause: () => {},
        onResume: () => {},
        onRunNow: () => {}
      })
    );

    expect(html).toContain('任务详情');
    expect(html).toContain('复制 ID');
    expect(html).toContain('打开聊天');
    expect(html).toContain('每小时检查一次');
    expect(html).not.toContain('删除任务');
  });

  it('shows delete action for terminal background tasks', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetailDrawer, {
        item: createItem('cancelled'),
        detail: createDetail('cancelled'),
        scheduledRuns: [],
        onCancel: () => {},
        onDelete: () => {},
        onOpenInChat: () => {},
        onOpenChat: () => {},
        onPause: () => {},
        onResume: () => {},
        onRunNow: () => {}
      })
    );

    expect(html).toContain('删除任务');
    expect(html).not.toContain('立即运行');
    expect(html).not.toContain('暂停');
    expect(html).not.toContain('继续');
    expect(html).not.toContain('取消');
  });
});
