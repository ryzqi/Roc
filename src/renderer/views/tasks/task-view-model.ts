import type { ActiveTaskItem, TaskStatus } from '../../../shared/types';

type TaskBoardLaneId = 'todo' | 'running' | 'paused' | 'done';

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

export type TaskNavMetaCounts = {
  activeCount: number;
  pendingApprovalCount: number;
  scheduledCount: number;
};

const activeStatuses: ReadonlySet<TaskStatus> = new Set([
  'dispatch_pending',
  'running',
  'recovering',
  'waiting_user',
  'waiting_next_turn',
  'paused',
  'pending_confirmation'
]);

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

export function countTaskNavMeta(items: ActiveTaskItem[]): TaskNavMetaCounts {
  let activeCount = 0;
  let pendingApprovalCount = 0;
  let scheduledCount = 0;
  for (const item of items) {
    if (activeStatuses.has(item.status)) activeCount += 1;
    if (item.status === 'pending_confirmation') pendingApprovalCount += 1;
    if (item.nextRunAt !== null && item.lastRunAt === null) scheduledCount += 1;
  }
  return { activeCount, pendingApprovalCount, scheduledCount };
}

export function buildTaskBoardLanes(items: ActiveTaskItem[]): TaskBoardLane[] {
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
