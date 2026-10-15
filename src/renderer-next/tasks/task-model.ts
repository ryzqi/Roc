import type { ActiveTaskItem, BackgroundTask, TaskStatus } from '../../shared/types';

/**
 * Task-board derivations (P6/T6.6), ported from `views/tasks/task-view-model.ts`.
 *
 * Kept as pure functions with unit tests for the same reason as the workflow rules: the
 * lane membership and the action availability are *decisions about the contract*
 * (`taskStatusSchema` has 13 values), not styling. Getting them wrong shows a task in the
 * wrong column, or offers 暂停 on a task the backend will refuse.
 *
 * The status sets below are lifted verbatim from the legacy renderer, which had them
 * validated against the real backend; the new shell must not "improve" them without
 * evidence, so they are documented rather than reinterpreted.
 */

export type TaskBoardLaneId = 'todo' | 'running' | 'paused' | 'done';

export type TaskBoardLane = {
  id: TaskBoardLaneId;
  title: string;
  items: ActiveTaskItem[];
};

export type TaskActionAvailability = {
  cancel: boolean;
  delete: boolean;
  pause: boolean;
  resume: boolean;
  runNow: boolean;
};

/** Statuses counted as "active" by the tray summary / nav meta. */
const activeStatuses: ReadonlySet<TaskStatus> = new Set([
  'dispatch_pending',
  'running',
  'recovering',
  'waiting_user',
  'waiting_next_turn',
  'paused',
  'pending_confirmation'
]);

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

const laneConfig: Array<{ id: TaskBoardLaneId; title: string; statuses: TaskStatus[] }> = [
  { id: 'todo', title: '待处理', statuses: ['draft', 'pending_confirmation', 'waiting_user'] },
  { id: 'running', title: '进行中', statuses: ['dispatch_pending', 'running', 'recovering', 'waiting_next_turn'] },
  { id: 'paused', title: '已暂停', statuses: ['paused'] },
  { id: 'done', title: '已结束', statuses: ['failed', 'cancelled', 'completed', 'interrupted', 'archived'] }
];

export function buildTaskBoardLanes(items: readonly ActiveTaskItem[]): TaskBoardLane[] {
  return laneConfig.map((lane) => ({
    id: lane.id,
    title: lane.title,
    items: items.filter((item) => lane.statuses.includes(item.status))
  }));
}

export function getTaskActionAvailability(status: TaskStatus): TaskActionAvailability {
  return {
    cancel: cancelStatuses.has(status),
    delete: deleteStatuses.has(status),
    pause: pauseStatuses.has(status),
    resume: status === 'paused',
    runNow: runNowStatuses.has(status)
  };
}

export type TaskNavMetaCounts = {
  activeCount: number;
  pendingApprovalCount: number;
  scheduledCount: number;
};

export function countTaskNavMeta(items: readonly ActiveTaskItem[]): TaskNavMetaCounts {
  let activeCount = 0;
  let pendingApprovalCount = 0;
  let scheduledCount = 0;
  for (const item of items) {
    if (activeStatuses.has(item.status)) {
      activeCount += 1;
    }
    if (item.status === 'pending_confirmation') {
      pendingApprovalCount += 1;
    }
    if (item.nextRunAt !== null && item.lastRunAt === null) {
      scheduledCount += 1;
    }
  }
  return { activeCount, pendingApprovalCount, scheduledCount };
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

export const backgroundTaskRiskLabels: Record<BackgroundTask['riskLevel'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险'
};
