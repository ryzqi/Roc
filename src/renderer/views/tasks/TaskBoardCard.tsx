import type { ActiveTaskItem } from '../../../shared/types';

export function TaskBoardCard({
  item,
  onOpenTask
}: {
  item: ActiveTaskItem;
  onOpenTask: () => void;
}): React.JSX.Element {
  return (
    <button className="task-board-card" data-testid={`task-board-card-${item.taskId}`} type="button" onClick={onOpenTask}>
      <span className="task-board-card-status status-pill info">{item.status}</span>
      <span className="task-board-card-title">{item.goal}</span>
      <span className="task-board-card-workspace">{item.workspacePath ?? '无工作区'}</span>
    </button>
  );
}
