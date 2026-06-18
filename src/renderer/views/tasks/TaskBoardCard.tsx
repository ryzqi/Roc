import type { ActiveTaskItem } from '../../../shared/types';

export function TaskBoardCard({
  item,
  onOpenTask
}: {
  item: ActiveTaskItem;
  onOpenTask: () => void;
}): React.JSX.Element {
  const itemId = item.taskId ?? item.threadId;

  return (
    <button className="task-board-card" data-testid={`task-board-card-${itemId}`} type="button" onClick={onOpenTask}>
      <span className="task-board-card-status status-pill info">{item.status}</span>
      <span className="task-board-card-title">{item.goal}</span>
      <span className="task-board-card-workspace">{item.workspacePath ?? '无工作区'}</span>
    </button>
  );
}
