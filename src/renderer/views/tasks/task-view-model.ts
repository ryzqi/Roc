import type { ActiveTaskItem, TaskStatus } from '../../../shared/types';
import type { LoadedState } from '../../loaded-state';

export type TaskGroupId =
  | 'pending_confirmation'
  | 'running'
  | 'scheduled'
  | 'paused'
  | 'failed'
  | 'recent_completed';

export type TaskViewGroup = {
  id: TaskGroupId;
  title: string;
  defaultExpanded: boolean;
  items: ActiveTaskItem[];
};

export type TaskViewModel = {
  allItems: ActiveTaskItem[];
  groups: TaskViewGroup[];
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
  const groups = [
    {
      id: 'pending_confirmation',
      title: '待确认',
      defaultExpanded: true,
      items: allItems.filter((item) => item.status === 'pending_confirmation')
    },
    {
      id: 'running',
      title: '运行中',
      defaultExpanded: true,
      items: allItems.filter((item) => runningStatuses.has(item.status) && !isScheduledBeforeFirstRun(item))
    },
    {
      id: 'scheduled',
      title: '计划中',
      defaultExpanded: true,
      items: allItems.filter(isScheduledBeforeFirstRun)
    },
    {
      id: 'paused',
      title: '已暂停',
      defaultExpanded: false,
      items: allItems.filter((item) => item.status === 'paused')
    },
    {
      id: 'failed',
      title: '已失败',
      defaultExpanded: false,
      items: allItems.filter((item) => item.status === 'failed')
    },
    {
      id: 'recent_completed',
      title: '最近完成',
      defaultExpanded: false,
      items: allItems.filter((item) => item.status === 'completed' && nowMs - new Date(item.updatedAt).getTime() <= recentCompletedWindowMs)
    }
  ].filter((group) => group.items.length > 0) as TaskViewGroup[];

  return {
    allItems,
    groups,
    counts: countTaskNavMeta(allItems)
  };
}

function dedupeBackgroundFirst(items: ActiveTaskItem[]): ActiveTaskItem[] {
  const byThread = new Map<string, ActiveTaskItem>();
  for (const item of items) {
    const existing = byThread.get(item.threadId);
    if (existing === undefined || (existing.kind === 'long_running' && item.kind === 'background')) {
      byThread.set(item.threadId, item);
    }
  }
  return [...byThread.values()];
}

function isScheduledBeforeFirstRun(item: ActiveTaskItem): boolean {
  return item.nextRunAt !== null && item.lastRunAt === null && item.status === 'running';
}
