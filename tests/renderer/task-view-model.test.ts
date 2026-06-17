import { describe, expect, it } from 'vitest';
import type { ActiveTaskItem } from '../../src/shared/types';
import { countTaskNavMeta } from '../../src/renderer/views/tasks/task-view-model';

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
    goal: goal === undefined ? title : goal,
    status,
    trigger: null,
    nextRunAt: null,
    lastRunAt: null,
    riskLevel: 'low',
    workspacePath: null,
    createdAt: createdAt === undefined ? '2026-05-20T00:00:00.000Z' : createdAt,
    updatedAt: updatedAt === undefined ? '2026-05-20T00:00:00.000Z' : updatedAt,
    ...rest
  };
}

describe('task nav metadata', () => {
  it('counts active, pending approval, and scheduled task metadata for navigation', () => {
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
      }),
      task({
        threadId: 'completed',
        title: '已完成',
        status: 'completed',
        nextRunAt: '2026-05-23T01:00:00.000Z',
        lastRunAt: '2026-05-22T01:00:00.000Z'
      })
    ]);

    expect(counts).toEqual({
      activeCount: 4,
      pendingApprovalCount: 1,
      scheduledCount: 1
    });
  });
});
