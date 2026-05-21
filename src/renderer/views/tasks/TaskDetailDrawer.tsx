import type { ActiveTaskItem } from '../../../shared/types';

export function TaskDetailDrawer({
  item,
  onCancel,
  onOpenInChat,
  onPause,
  onResume,
  onRunNow
}: {
  item: ActiveTaskItem | null;
  onCancel: (item: ActiveTaskItem) => void;
  onOpenInChat: (item: ActiveTaskItem) => void;
  onPause: (item: ActiveTaskItem) => void;
  onResume: (item: ActiveTaskItem) => void;
  onRunNow: (item: ActiveTaskItem) => void;
}): React.JSX.Element {
  if (item === null) {
    return (
      <aside className="task-detail-drawer" data-testid="task-detail-drawer">
        <div className="section-empty-state">
          <strong>选择一个任务查看详情</strong>
          <p>任务详情会显示运行、触发、工作区和调度状态。</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="task-detail-drawer" data-testid="task-detail-drawer">
      <div className="section-head">
        <h2 className="section-title">任务详情</h2>
        <span className="status-pill info">
          <span>{item.status}</span>
        </span>
      </div>
      <div className="task-detail-tabs" role="tablist" aria-label="任务详情">
        <span>概览</span>
        <span>运行历史</span>
        <span>事件流</span>
        <span>设置</span>
      </div>
      <div className="list-rows">
        <div className="row">
          <div className="row-copy">
            <div className="row-title">调度器</div>
            <div className="row-sub">{item.nextRunAt === null ? '未注册下一次运行' : `下次 ${item.nextRunAt}`}</div>
          </div>
          <span className="pill info">最近调度</span>
        </div>
        <div className="row">
          <div className="row-copy">
            <div className="row-title">目标</div>
            <div className="row-sub">{item.goal}</div>
          </div>
          <span className="pill info">{item.kind}</span>
        </div>
        <div className="row">
          <div className="row-copy">
            <div className="row-title">触发</div>
            <div className="row-sub">{formatTrigger(item)}</div>
          </div>
          <span className="pill warn">{item.riskLevel}</span>
        </div>
        <div className="row">
          <div className="row-copy">
            <div className="row-title">工作区</div>
            <div className="row-sub">{item.workspacePath ?? '无'}</div>
          </div>
          <span className="pill info">scope</span>
        </div>
      </div>
      <div className="action-strip">
        <button type="button" onClick={() => onOpenInChat(item)}>让 AI 修改</button>
        <button type="button" onClick={() => onRunNow(item)}>立即运行</button>
        {item.status === 'paused' ? (
          <button type="button" onClick={() => onResume(item)}>继续</button>
        ) : (
          <button type="button" onClick={() => onPause(item)}>暂停</button>
        )}
        <button type="button" onClick={() => onCancel(item)}>取消</button>
        <button type="button">打开聊天</button>
        <button type="button">复制 ID</button>
      </div>
    </aside>
  );
}

function formatTrigger(item: ActiveTaskItem): string {
  if (item.trigger === null) {
    return '长会话';
  }
  if (item.trigger.type === 'cron') {
    return `${item.trigger.description} (${item.trigger.cronExpression})`;
  }
  return item.trigger.description;
}
