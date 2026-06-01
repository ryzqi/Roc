import type { ActiveTaskItem, TaskStatus } from '../../../shared/types';
import type { LoadedState } from '../../loaded-state';

export type TaskRailId = 'all' | 'running' | 'scheduled' | 'pending_confirmation' | 'paused' | 'failed' | 'terminal';

export type TaskRailItem = {
  id: TaskRailId;
  title: string;
  count: number;
};

export type TaskViewModel = {
  allItems: ActiveTaskItem[];
  railItems: TaskRailItem[];
  counts: {
    activeCount: number;
    pendingApprovalCount: number;
    scheduledCount: number;
  };
};

const activeStatuses: ReadonlySet<TaskStatus> = new Set([
  'running',
  'waiting_user',
  'waiting_next_turn',
  'paused',
  'pending_confirmation'
]);
const runningStatuses: ReadonlySet<TaskStatus> = new Set(['running', 'waiting_user', 'waiting_next_turn']);
const terminalStatuses: ReadonlySet<TaskStatus> = new Set(['cancelled', 'completed']);
const recentCompletedWindowMs = 7 * 24 * 60 * 60 * 1000;

export function countTaskNavMeta(items: ActiveTaskItem[]): TaskViewModel['counts'] {
  return {
    activeCount: items.filter((item) => activeStatuses.has(item.status)).length,
    pendingApprovalCount: items.filter((item) => item.status === 'pending_confirmation').length,
    scheduledCount: items.filter((item) => item.nextRunAt !== null && item.lastRunAt === null).length
  };
}

export function buildTaskViewModel(state: LoadedState, nowIso = new Date().toISOString()): TaskViewModel {
  const allItems = dedupeBackgroundFirst(state.activeTasks).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const nowMs = new Date(nowIso).getTime();
  const recentCompletedItems = allItems.filter(
    (item) => item.status === 'completed' && nowMs - new Date(item.updatedAt).getTime() <= recentCompletedWindowMs
  );
  const terminalItems = allItems.filter(
    (item) =>
      terminalStatuses.has(item.status) &&
      !(item.status === 'completed' && nowMs - new Date(item.updatedAt).getTime() <= recentCompletedWindowMs)
  );
  const railItems: TaskRailItem[] = [
    { id: 'all', title: '全部', count: allItems.length },
    { id: 'running', title: '运行中', count: allItems.filter((item) => runningStatuses.has(item.status) && !isScheduledBeforeFirstRun(item)).length },
    { id: 'scheduled', title: '计划中', count: allItems.filter(isScheduledBeforeFirstRun).length },
    { id: 'pending_confirmation', title: '待确认', count: allItems.filter((item) => item.status === 'pending_confirmation').length },
    { id: 'paused', title: '已暂停', count: allItems.filter((item) => item.status === 'paused').length },
    { id: 'failed', title: '异常', count: allItems.filter((item) => item.status === 'failed').length },
    { id: 'terminal', title: '已结束', count: recentCompletedItems.length + terminalItems.length }
  ];

  return {
    allItems,
    railItems,
    counts: countTaskNavMeta(allItems)
  };
}

export function filterTaskItems(items: ActiveTaskItem[], railId: TaskRailId): ActiveTaskItem[] {
  if (railId === 'all') {
    return items;
  }
  if (railId === 'running') {
    return items.filter((item) => runningStatuses.has(item.status) && !isScheduledBeforeFirstRun(item));
  }
  if (railId === 'scheduled') {
    return items.filter(isScheduledBeforeFirstRun);
  }
  if (railId === 'pending_confirmation') {
    return items.filter((item) => item.status === 'pending_confirmation');
  }
  if (railId === 'paused') {
    return items.filter((item) => item.status === 'paused');
  }
  if (railId === 'failed') {
    return items.filter((item) => item.status === 'failed');
  }
  return items.filter((item) => terminalStatuses.has(item.status));
}

export function resolveTaskDisplayStatus(item: ActiveTaskItem): string {
  if (isScheduledBeforeFirstRun(item)) {
    return '计划中';
  }
  if (item.status === 'pending_confirmation') {
    return '待确认';
  }
  if (item.status === 'waiting_user') {
    return '等待用户';
  }
  if (item.status === 'waiting_next_turn') {
    return '等待下轮';
  }
  if (item.status === 'running') {
    return '运行中';
  }
  if (item.status === 'paused') {
    return '已暂停';
  }
  if (item.status === 'failed') {
    return '失败';
  }
  if (item.status === 'completed') {
    return '已完成';
  }
  if (item.status === 'cancelled') {
    return '已取消';
  }
  return item.status;
}

function dedupeBackgroundFirst(items: ActiveTaskItem[]): ActiveTaskItem[] {
  const byTask = new Map<string, ActiveTaskItem>();
  for (const item of items) {
    const itemId = item.taskId ?? item.threadId;
    if (!byTask.has(itemId)) {
      byTask.set(itemId, item);
    }
  }
  return [...byTask.values()];
}

function isScheduledBeforeFirstRun(item: ActiveTaskItem): boolean {
  return item.nextRunAt !== null && item.lastRunAt === null && item.status === 'running';
}
