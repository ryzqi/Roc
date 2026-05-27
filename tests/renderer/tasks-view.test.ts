import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TasksView } from '../../src/renderer/views/tasks/TasksView';
import { createLoadedState } from './view-test-helpers';

describe('TasksView', () => {
  it('renders active task center sections instead of the legacy single background task panel', () => {
    const html = renderToStaticMarkup(
      React.createElement(TasksView, {
        state: createLoadedState({
          activeTasks: [
            {
              kind: 'background',
              threadId: 'thread-1',
              taskId: 'bg-1',
              title: '整理工作区变更',
              goal: '整理工作区变更',
              status: 'running',
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
            }
          ],
          taskDetail: {
            threadId: 'thread-1',
            taskId: 'bg-1',
            lastRunId: 'run-1',
            schedulerRegistered: true,
            thread: {
              id: 'thread-1',
              kind: 'background',
              title: '整理工作区变更',
              goal: '整理工作区变更',
              status: 'running',
              createdAt: '2026-05-16T07:00:00.000Z',
              updatedAt: '2026-05-16T07:05:00.000Z'
            },
            backgroundTask: {
              id: 'bg-1',
              threadId: 'thread-1',
              runId: 'run-1',
              goal: '整理工作区变更',
              status: 'running',
              scheduled: true,
              triggerType: 'cron',
              triggerDescription: '每小时检查一次',
              nextRunAt: '2026-05-16T08:00:00.000Z',
              cronExpression: '0 * * * *',
              workspacePath: 'F:\\Code\\Roc',
              allowedActions: ['read'],
              forbiddenActions: ['delete'],
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
          },
          scheduledRuns: [
            {
              id: 'scheduled-1',
              backgroundTaskId: 'bg-1',
              taskRunId: 'run-1',
              scheduledAt: '2026-05-16T08:00:00.000Z',
              triggeredAt: '2026-05-16T08:00:30.000Z',
              status: 'fired',
              skipReason: null
            }
          ],
          schedulerStatus: {
            running: true,
            registeredTaskCount: 1,
            nextFireAt: '2026-05-16T08:00:00.000Z',
            recentSkippedCount: 0,
            lastError: null
          },
          traySummary: {
            residentEnabled: true,
            backgroundPaused: false,
            nextRunAt: '2026-05-16T08:00:00.000Z',
            updatedAt: '2026-05-16T07:05:00.000Z',
            backgroundTasks: {
              total: 3,
              running: 1,
              failed: 0,
              pendingConfirmation: 2,
              nextRunAt: '2026-05-16T08:00:00.000Z'
            }
          },
          taskSnapshot: {
            generatedAt: '2026-05-16T07:05:00.000Z',
            counts: {
              total: 3,
              running: 1,
              failed: 0,
              pendingConfirmation: 2
            },
            threads: [],
            recentEvents: []
          }
        }),
        updateLoadedState: () => {},
        liveTaskRun: null,
        onNavigateToThread: () => {},
        onSelectedTaskIdChange: () => {},
        onSubmitTaskPrompt: async () => ({ ok: true as const })
      })
    );

    expect(html).toContain('class="canvas-stage stage-grid task-command-center"');
    expect(html).toContain('class="task-summary-band"');
    expect(html).toContain('data-testid="tasks-view"');
    expect(html).toContain('活跃任务');
    expect(html).toContain('详情');
    expect(html).toContain('最近调度');
    expect(html).toContain('调度器');
    expect(html).not.toContain('data-testid="task-create-dialog-panel"');
    expect(html).not.toContain('data-testid="task-create-dialog-backdrop"');
    expect(html).toContain('整理工作区变更');
    expect(html).toContain('每小时检查一次');
    expect(html).toContain('让 AI 修改');
    expect(html).toContain('立即运行');
    expect(html).toContain('bg-1');
    expect(html).toContain('class="task-summary-band"');
    expect(html).toContain('class="section task-list-section"');
    expect(html).toContain('class="section-head"');
    expect(html).toContain('class="list-rows"');
    expect(html).not.toContain('暂无后台任务');
    expect(html).not.toContain('后台任务</h2>');
    expect(html).not.toContain('card-title');
  });

  it('renders the task workbench empty state when there are no active tasks', () => {
    const html = renderToStaticMarkup(
      React.createElement(TasksView, {
        state: createLoadedState({
          activeTasks: []
        }),
        updateLoadedState: () => {},
        liveTaskRun: null,
        onNavigateToThread: () => {},
        onSelectedTaskIdChange: () => {},
        onSubmitTaskPrompt: async () => ({ ok: true as const })
      })
    );

    expect(html).toContain('data-testid="tasks-empty-state"');
    expect(html).toContain('class="task-empty-shell"');
    expect(html).toContain('class="canvas-stage stage-grid task-command-center"');
    expect(html).toContain('帮我创建一个定时任务');
    expect(html).toContain('新建任务');
    expect(html).not.toContain('data-testid="task-create-dialog-panel"');
    expect(html).not.toContain('data-testid="task-create-dialog-backdrop"');
  });
});
