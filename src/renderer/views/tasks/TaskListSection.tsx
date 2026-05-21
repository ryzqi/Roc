import type { ActiveTaskItem } from '../../../shared/types';
import type { TaskViewGroup } from './task-view-model';
import { TaskRow } from './TaskRow';

export function TaskListSection({
  group,
  onSelect,
  selectedId
}: {
  group: TaskViewGroup;
  onSelect: (item: ActiveTaskItem) => void;
  selectedId: string | null;
}): React.JSX.Element {
  return (
    <section className="section task-list-section" data-testid={`task-list-section-${group.id}`}>
      <div className="section-head">
        <h2 className="section-title">{group.title}</h2>
        <span className="status-pill info">
          <span>{group.items.length}</span>
        </span>
      </div>
      <div className="list-rows">
        {group.items.map((item) => {
          const itemId = item.taskId ?? item.threadId;
          return <TaskRow key={itemId} item={item} selected={selectedId === itemId} onSelect={onSelect} />;
        })}
      </div>
    </section>
  );
}
