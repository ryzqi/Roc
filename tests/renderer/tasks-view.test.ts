import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TasksView } from '../../src/renderer/views/tasks/TasksView';
import { createLoadedState } from './view-test-helpers';

describe('TasksView', () => {
  it('renders phase 4 section layout instead of legacy grids and cards', () => {
    const html = renderToStaticMarkup(
      React.createElement(TasksView, {
        state: createLoadedState({
          backgroundTask: {
            id: 'bg-1',
            threadId: 'thread-1',
            runId: 'run-1',
            goal: '整理工作区变更',
            status: 'running',
            scheduled: true,
            triggerDescription: '每小时检查一次',
            nextRunAt: '2026-05-16T08:00:00.000Z',
            workspacePath: 'F:\\Code\\Roc',
            allowedActions: ['read'],
            forbiddenActions: ['delete'],
            failurePolicy: 'pause_and_report',
            notificationPolicy: 'failures_and_confirmations',
            riskLevel: 'medium',
            requiresConfirmation: true,
            createdAt: '2026-05-16T07:00:00.000Z',
            updatedAt: '2026-05-16T07:05:00.000Z'
          },
          backgroundTasks: [
            {
              id: 'bg-1',
              threadId: 'thread-1',
              runId: 'run-1',
              goal: '整理工作区变更',
              status: 'running',
              scheduled: true,
              triggerDescription: '每小时检查一次',
              nextRunAt: '2026-05-16T08:00:00.000Z',
              workspacePath: 'F:\\Code\\Roc',
              allowedActions: ['read'],
              forbiddenActions: ['delete'],
              failurePolicy: 'pause_and_report',
              notificationPolicy: 'failures_and_confirmations',
              riskLevel: 'medium',
              requiresConfirmation: true,
              createdAt: '2026-05-16T07:00:00.000Z',
              updatedAt: '2026-05-16T07:05:00.000Z'
            }
          ],
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
            recentEvents: [
              {
                id: 'event-1',
                threadId: 'thread-1',
                runId: 'run-1',
                type: 'approval_requested',
                payload: {
                  actionRequests: [{ name: 'execute' }]
                },
                createdAt: '2026-05-16T07:04:00.000Z'
              }
            ]
          }
        }),
        updateLoadedState: () => {}
      })
    );

    expect(html).toContain('data-testid="tasks-view"');
    expect(html).toContain('class="stat-row"');
    expect(html).toContain('class="section"');
    expect(html).toContain('class="section-head"');
    expect(html).toContain('class="list-rows"');
    expect(html).toContain('class="task-surface-grid"');
    expect(html).toContain('任务');
    expect(html).toContain('3 个任务 · 运行中 1');
    expect(html).not.toContain('本机 1 个工作区');
    expect(html).not.toContain('grid-3');
    expect(html).not.toContain('grid-2');
    expect(html).not.toContain('card-title');
  });
});
