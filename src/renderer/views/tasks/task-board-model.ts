import type { ActiveTaskItem, TaskStatus } from '../../../shared/types';

export type TaskBoardLaneId = 'todo' | 'running' | 'paused' | 'done';

export type TaskBoardLane = {
  id: TaskBoardLaneId;
  title: string;
  statuses: TaskStatus[];
  items: ActiveTaskItem[];
};

const laneConfig: Array<{ id: TaskBoardLaneId; title: string; statuses: TaskStatus[] }> = [
  { id: 'todo', title: '待处理', statuses: ['pending_confirmation', 'waiting_user'] },
  { id: 'running', title: '进行中', statuses: ['running', 'waiting_next_turn'] },
  { id: 'paused', title: '已暂停', statuses: ['paused'] },
  { id: 'done', title: '已结束', statuses: ['failed', 'cancelled', 'completed', 'archived'] }
];

export function buildTaskBoardLanes(items: ActiveTaskItem[]): TaskBoardLane[] {
  return laneConfig.map((lane) => ({
    ...lane,
    items: items.filter((item) => lane.statuses.includes(item.status))
  }));
}
