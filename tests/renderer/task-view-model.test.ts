import { describe, expect, it } from 'vitest';
import type { ActiveTaskItem } from '../../src/shared/types';
import type { TaskStatus } from '../../src/shared/types';
import {
  buildTaskBoardLanes,
  countTaskNavMeta,
  getTaskActionAvailability
} from '../../src/renderer/views/tasks/task-view-model';

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

  it('projects task statuses into board lanes from the same presentation policy', () => {
    const statuses: TaskStatus[] = [
      'draft',
      'pending_confirmation',
      'dispatch_pending',
      'running',
      'recovering',
      'paused',
      'waiting_user',
      'waiting_next_turn',
      'failed',
      'cancelled',
      'completed',
      'interrupted',
      'archived'
    ];
    const lanes = buildTaskBoardLanes(statuses.map((status) => task({ threadId: status, title: status, status })));

    expect(lanes.map((lane) => [lane.id, lane.items.map((item) => item.taskId)])).toEqual([
      ['todo', ['background-draft', 'background-pending_confirmation', 'background-waiting_user']],
      ['running', ['background-dispatch_pending', 'background-running', 'background-recovering', 'background-waiting_next_turn']],
      ['paused', ['background-paused']],
      ['done', ['background-failed', 'background-cancelled', 'background-completed', 'background-interrupted', 'background-archived']]
    ]);
  });

  it('projects the complete task action state matrix from backend transition rules', () => {
    const statuses: TaskStatus[] = [
      'draft',
      'pending_confirmation',
      'dispatch_pending',
      'running',
      'recovering',
      'paused',
      'waiting_user',
      'waiting_next_turn',
      'failed',
      'cancelled',
      'completed',
      'interrupted',
      'archived'
    ];

    expect(Object.fromEntries(statuses.map((status) => [status, getTaskActionAvailability(status)]))).toEqual({
      draft: { cancel: true, delete: false, pause: false, resume: false, runNow: true },
      pending_confirmation: { cancel: true, delete: false, pause: true, resume: false, runNow: true },
      dispatch_pending: { cancel: false, delete: false, pause: false, resume: false, runNow: false },
      running: { cancel: true, delete: false, pause: true, resume: false, runNow: true },
      recovering: { cancel: false, delete: false, pause: false, resume: false, runNow: false },
      paused: { cancel: true, delete: false, pause: false, resume: true, runNow: true },
      waiting_user: { cancel: true, delete: false, pause: false, resume: false, runNow: true },
      waiting_next_turn: { cancel: true, delete: false, pause: false, resume: false, runNow: true },
      failed: { cancel: true, delete: true, pause: false, resume: false, runNow: true },
      cancelled: { cancel: false, delete: true, pause: false, resume: false, runNow: false },
      completed: { cancel: false, delete: true, pause: false, resume: false, runNow: false },
      interrupted: { cancel: false, delete: false, pause: false, resume: false, runNow: false },
      archived: { cancel: false, delete: false, pause: false, resume: false, runNow: false }
    });
  });
});
