import { describe, expect, it } from 'vitest';
import type { ActiveTaskItem } from '../../src/shared/types';
import { buildTaskViewModel, countTaskNavMeta } from '../../src/renderer/views/tasks/task-view-model';
import { createLoadedState } from './view-test-helpers';

function task(input: Partial<ActiveTaskItem> & Pick<ActiveTaskItem, 'threadId' | 'title' | 'status'>): ActiveTaskItem {
  const {
    threadId,
    title,
    status,
    goal,
    createdAt,
    updatedAt,
    ...rest
  } = input;
  return {
    kind: 'background',
    threadId,
    taskId: `background-${threadId}`,
    title,
    goal: goal ?? title,
    status,
    trigger: null,
    nextRunAt: null,
    lastRunAt: null,
    riskLevel: 'low',
    workspacePath: null,
    createdAt: createdAt ?? '2026-05-20T00:00:00.000Z',
    updatedAt: updatedAt ?? '2026-05-20T00:00:00.000Z',
    ...rest
  };
}

describe('task workbench view model', () => {
  it('groups active tasks by pending, running, scheduled, paused, failed, and recent completion rules', () => {
    const state = createLoadedState({
      activeTasks: [
        task({ threadId: 'pending', title: '等待审批', status: 'pending_confirmation' }),
        task({ threadId: 'running', title: '正在运行', status: 'running' }),
        task({
          kind: 'background',
          threadId: 'scheduled',
          taskId: 'background-scheduled',
          title: '计划任务',
          status: 'running',
          trigger: {
            type: 'cron',
            description: '每天 09:00',
            cronExpression: '0 9 * * *',
            nextRunAt: '2026-05-22T01:00:00.000Z'
          },
          nextRunAt: '2026-05-22T01:00:00.000Z',
          lastRunAt: null
        }),
        task({ threadId: 'paused', title: '已暂停', status: 'paused' }),
        task({ threadId: 'failed', title: '已失败', status: 'failed' }),
        task({
          threadId: 'recent-completed',
          title: '最近完成',
          status: 'completed',
          updatedAt: '2026-05-18T00:00:00.000Z'
        }),
        task({
          threadId: 'old-completed',
          title: '旧完成',
          status: 'completed',
          updatedAt: '2026-05-01T00:00:00.000Z'
        })
      ]
    });

    const model = buildTaskViewModel(state, '2026-05-21T00:00:00.000Z');

    expect(model.groups.map((group) => [group.id, group.items.map((item) => item.threadId)])).toEqual([
      ['pending_confirmation', ['pending']],
      ['running', ['running']],
      ['scheduled', ['scheduled']],
      ['paused', ['paused']],
      ['failed', ['failed']],
      ['recent_completed', ['recent-completed']],
      ['terminal', ['old-completed']]
    ]);
    expect(model.groups.find((group) => group.id === 'pending_confirmation')?.defaultExpanded).toBe(true);
    expect(model.groups.find((group) => group.id === 'paused')?.defaultExpanded).toBe(false);
  });

  it('keeps cancelled terminal tasks visible so task counts cannot render an empty list', () => {
    const state = createLoadedState({
      activeTasks: [
        task({ threadId: 'cancelled-1', title: '已取消任务一', status: 'cancelled' }),
        task({ threadId: 'cancelled-2', title: '已取消任务二', status: 'cancelled' }),
        task({ threadId: 'cancelled-3', title: '已取消任务三', status: 'cancelled' })
      ],
      taskSnapshot: {
        generatedAt: '2026-05-21T00:00:00.000Z',
        recentEvents: [],
        counts: {
          total: 3,
          running: 0,
          failed: 0,
          pendingConfirmation: 0
        },
        threads: []
      }
    });

    const model = buildTaskViewModel(state, '2026-05-21T00:00:00.000Z');

    expect(model.allItems).toHaveLength(3);
    expect(model.groups.map((group) => [group.id, group.items.map((item) => item.threadId)])).toEqual([
      ['terminal', ['cancelled-1', 'cancelled-2', 'cancelled-3']]
    ]);
  });

  it('keeps one item per background thread', () => {
    const state = createLoadedState({
      activeTasks: [
        task({
          threadId: 'same-thread',
          taskId: 'background-first',
          title: '后台任务一',
          status: 'running'
        }),
        task({
          threadId: 'same-thread',
          taskId: 'background-second',
          title: '后台任务二',
          status: 'running'
        })
      ]
    });

    const model = buildTaskViewModel(state, '2026-05-21T00:00:00.000Z');

    expect(model.allItems).toEqual([
      expect.objectContaining({
        kind: 'background',
        threadId: 'same-thread',
        taskId: 'background-first'
      })
    ]);
  });

  it('counts nav metadata from active task statuses and scheduled definitions', () => {
    const counts = countTaskNavMeta([
      task({ threadId: 'pending', title: '等待审批', status: 'pending_confirmation' }),
      task({ threadId: 'paused', title: '已暂停', status: 'paused' }),
      task({ threadId: 'waiting', title: '等待用户', status: 'waiting_user' }),
      task({
        threadId: 'scheduled',
        title: '计划任务',
        status: 'running',
        trigger: {
          type: 'once',
          description: '一次',
          nextRunAt: '2026-05-22T01:00:00.000Z'
        },
        nextRunAt: '2026-05-22T01:00:00.000Z',
        lastRunAt: null
      })
    ]);

    expect(counts).toEqual({
      activeCount: 4,
      pendingApprovalCount: 1,
      scheduledCount: 1
    });
  });
});
