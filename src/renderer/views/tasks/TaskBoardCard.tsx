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
      <span className="task-board-card-title">{item.goal}</span>
      <span className="task-board-card-meta">{item.status}</span>
      <span className="task-board-card-meta">{item.workspacePath ?? '无工作区'}</span>
    </button>
  );
}
