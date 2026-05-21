export function TaskCreateDialog({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  if (!open) {
    return null;
  }
  return (
    <div className="task-create-dialog" data-testid="task-create-dialog" role="dialog" aria-modal="true" aria-label="新建任务">
      <div className="section-head">
        <h2 className="section-title">新建任务</h2>
        <button type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="section-empty-state">
        <strong>手动新建入口</strong>
        <p>当前阶段保留入口；完整表单会复用后台任务工具的字段契约。</p>
      </div>
    </div>
  );
}
