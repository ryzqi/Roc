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
        <span className="task-board-column-count status-pill info">
          <span>{items.length}</span>
        </span>
      </header>
      <div className="task-board-column-list">
        {items.length === 0 ? (
          <p className="task-board-column-empty">此列暂无任务</p>
        ) : (
          items.map((item) => {
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
          })
        )}
      </div>
    </section>
  );
}
