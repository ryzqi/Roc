import { useChatRun } from '../../chat/use-chat-run';
import { CompactStatusPill } from '../../components/CompactStatusPill';
import { Row } from '../../components/Row';
import type { LoadedState } from '../../loaded-state';

export function QuickEntryView({
  onSubmitChatTask,
  state
}: {
  onSubmitChatTask: (input: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: LoadedState;
}): React.JSX.Element {
  const chatRun = useChatRun();
  const failedTasks = state.taskSnapshot.counts.failed;
  const pendingConfirmations = state.traySummary.backgroundTasks.pendingConfirmation;
  const quickTaskInput = '快捷入口创建任务';

  async function submitQuickTask(): Promise<void> {
    const result = await onSubmitChatTask(quickTaskInput);
    if (!result.ok) {
      chatRun.setError(result.error);
    }
  }

  return (
    <section className="floating-shell floating-shell--quick" data-testid="quick-entry-view">
      <div className="mini-window single-panel" data-testid="quick-entry-visual">
        <div className="section-head">
          <h2 className="section-title">Roc 快捷入口</h2>
          <CompactStatusPill tone="ok" value="同步主窗口状态" />
        </div>
        <div className="settings-subsection">
          <div className="field-box">补充当前任务或创建新的本地任务</div>
          <div className="tab-row tab-row--quick">
            <button className="tab active" data-testid="quick-submit-task" type="button" onClick={() => void submitQuickTask()}>
              追加到当前任务
            </button>
            <button className="tab" data-testid="quick-open-tasks" type="button" onClick={() => void window.roc.app.openMainPage('tasks')}>
              创建新任务
            </button>
            <button className="tab" data-testid="quick-open-chat" type="button" onClick={() => void window.roc.app.openMainPage('chat')}>
              快速提问
            </button>
          </div>
        </div>
        <div className="list-rows">
          <Row
            title="后台任务"
            sub={`${state.traySummary.backgroundTasks.running} 个运行中`}
            tag="运行中"
            tone="info"
          />
          <Row
            title="待确认"
            sub={`${pendingConfirmations} 个高影响动作`}
            tag="需确认"
            tone="warn"
          />
          <Row
            title="失败"
            sub={`${failedTasks} 个失败任务`}
            tag={failedTasks > 0 ? '可修复' : '无'}
            tone={failedTasks > 0 ? 'bad' : 'ok'}
          />
        </div>
        {chatRun.errorMessage === null ? null : <span className="inline-warning" data-testid="quick-entry-error">{chatRun.errorMessage}</span>}
      </div>
    </section>
  );
}
