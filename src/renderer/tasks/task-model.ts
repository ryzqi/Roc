import type { TaskStatus } from '../../shared/types';

/**
 * Task action availability (P6/T6.6), ported from `views/tasks/task-view-model.ts`.
 *
 * Kept a pure function with unit tests for the same reason as the workflow rules: which actions a
 * status offers is *a decision about the contract* (`taskStatusSchema` has 13 values), not styling.
 * Getting it wrong offers 暂停 on a task the backend will refuse.
 *
 * The status sets below are lifted verbatim from the legacy renderer, which had them validated
 * against the real backend; the new shell must not "improve" them without evidence, so they are
 * documented rather than reinterpreted.
 */

export type TaskActionAvailability = {
  cancel: boolean;
  delete: boolean;
  pause: boolean;
  resume: boolean;
  runNow: boolean;
};

/** `task.background.pause` accepts these (`pauseBackgroundTask` → status guard). */
const pauseStatuses: ReadonlySet<TaskStatus> = new Set(['running', 'pending_confirmation']);

const cancelStatuses: ReadonlySet<TaskStatus> = new Set([
  'draft',
  'pending_confirmation',
  'running',
  'paused',
  'waiting_user',
  'waiting_next_turn',
  'failed'
]);

const deleteStatuses: ReadonlySet<TaskStatus> = new Set(['failed', 'cancelled', 'completed']);

const runNowStatuses: ReadonlySet<TaskStatus> = new Set([
  'draft',
  'pending_confirmation',
  'running',
  'paused',
  'waiting_user',
  'waiting_next_turn',
  'failed'
]);

export function getTaskActionAvailability(status: TaskStatus): TaskActionAvailability {
  return {
    cancel: cancelStatuses.has(status),
    delete: deleteStatuses.has(status),
    pause: pauseStatuses.has(status),
    resume: status === 'paused',
    runNow: runNowStatuses.has(status)
  };
}

export const taskStatusLabels: Record<TaskStatus, string> = {
  draft: '草稿',
  pending_confirmation: '待确认',
  dispatch_pending: '待派发',
  running: '执行中',
  recovering: '恢复中',
  paused: '已暂停',
  waiting_user: '等待输入',
  waiting_next_turn: '等待下一轮',
  failed: '失败',
  cancelled: '已取消',
  completed: '已完成',
  interrupted: '已中断',
  archived: '已归档'
};
