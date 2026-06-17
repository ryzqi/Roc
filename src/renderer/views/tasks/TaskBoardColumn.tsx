import type { ActiveTaskItem } from '../../../shared/types';
import { TaskBoardCard } from './TaskBoardCard';

export function TaskBoardColumn({
  items,
  onOpenTask,
  title
}: {
  items: ActiveTaskItem[];
  onOpenTask: (taskId: string) => void;
  title: string;
}): React.JSX.Element {
  return (
    <section className="task-board-column" data-testid={`task-board-column-${title}`}>
      <header className="task-board-column-head">
        <h2 className="section-title">{title}</h2>
        <span className="status-pill info">
          <span>{items.length}</span>
        </span>
      </header>
      <div className="task-board-column-list">
        {items.map((item) => {
          const itemId = item.taskId ?? item.threadId;
          return (
            <TaskBoardCard
              key={itemId}
              item={item}
              onOpenTask={() => {
                onOpenTask(itemId);
              }}
            />
          );
        })}
      </div>
    </section>
  );
}
