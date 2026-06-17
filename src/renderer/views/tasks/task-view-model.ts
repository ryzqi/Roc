import type { ActiveTaskItem, TaskStatus } from '../../../shared/types';

export type TaskNavMetaCounts = {
  activeCount: number;
  pendingApprovalCount: number;
  scheduledCount: number;
};

const activeStatuses: ReadonlySet<TaskStatus> = new Set([
  'running',
  'waiting_user',
  'waiting_next_turn',
  'paused',
  'pending_confirmation'
]);

export function countTaskNavMeta(items: ActiveTaskItem[]): TaskNavMetaCounts {
  return {
    activeCount: items.filter((item) => activeStatuses.has(item.status)).length,
    pendingApprovalCount: items.filter((item) => item.status === 'pending_confirmation').length,
    scheduledCount: items.filter((item) => item.nextRunAt !== null && item.lastRunAt === null).length
  };
}
