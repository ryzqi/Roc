import type { ActiveTaskItem } from '../../../shared/types';
import { sanitizeTestId } from '../../utils/sanitize-test-id';

export function TaskRow({
  item,
  onSelect,
  selected
}: {
  item: ActiveTaskItem;
  onSelect: (item: ActiveTaskItem) => void;
  selected: boolean;
}): React.JSX.Element {
  return (
    <button
      className={selected ? 'task-row task-row--selected' : 'task-row'}
      data-testid={`task-row-${sanitizeTestId(item.taskId ?? item.threadId)}`}
      title={`${item.goal}\n创建: ${item.createdAt}\n最近运行: ${item.lastRunAt ?? '无'}`}
      type="button"
      onClick={() => onSelect(item)}
    >
      <span className="task-row-copy">
        <span className="task-row-title">{item.goal}</span>
        <span className="task-row-meta">{formatTaskMeta(item)}</span>
      </span>
      <span className="task-row-tags">
        <span className="pill info">{formatTriggerTag(item)}</span>
        <span className="pill warn">{formatPrimaryAction(item)}</span>
      </span>
    </button>
  );
}

function formatTaskMeta(item: ActiveTaskItem): string {
  return [item.status, item.riskLevel, formatWorkspacePath(item.workspacePath)].join(' · ');
}

function formatWorkspacePath(workspacePath: string | null): string {
  if (workspacePath === null) {
    return '无工作区';
  }
  const parts = workspacePath.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.slice(-2).join('\\') || workspacePath;
}

function formatTriggerTag(item: ActiveTaskItem): string {
  if (item.trigger === null) {
    return '长任务';
  }
  if (item.trigger.type === 'manual') {
    return '手动';
  }
  if (item.trigger.type === 'once') {
    return '一次';
  }
  return '定时';
}

function formatPrimaryAction(item: ActiveTaskItem): string {
  if (item.status === 'pending_confirmation') {
    return '处理审批';
  }
  if (item.status === 'paused') {
    return '继续';
  }
  if (item.status === 'failed') {
    return '诊断';
  }
  return '查看';
}
