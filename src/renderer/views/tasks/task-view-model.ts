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
