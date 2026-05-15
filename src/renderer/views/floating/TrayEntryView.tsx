import type { TraySummary } from '../../../shared/types';
import { CompactStatusPill } from '../../components/CompactStatusPill';
import { Row } from '../../components/Row';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';

export function TrayEntryView({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const trayStatusTone = state.traySummary.backgroundPaused ? 'warn' : 'ok';
  const trayStatusValue = state.traySummary.backgroundPaused ? '已暂停' : '运行中';
  return (
    <section className="floating-shell floating-shell--tray" data-testid="tray-entry-view">
      <div className="tray-pop single-panel" data-testid="tray-entry-visual">
        <div className="section-head">
          <h2 className="section-title">Roc 常驻状态</h2>
          <CompactStatusPill tone={trayStatusTone} value={trayStatusValue} />
        </div>
        <div className="list-rows">
          <Row title="后台任务" sub={`${state.traySummary.backgroundTasks.running} 个运行中，${state.traySummary.backgroundTasks.pendingConfirmation} 个等待用户`} tag="查看" tone="info" />
          <Row
            title="失败任务"
            sub={`${state.taskSnapshot.counts.failed} 个失败任务`}
            tag="修复"
            tone={state.taskSnapshot.counts.failed > 0 ? 'bad' : 'ok'}
          />
          <Row title="待确认" sub={`${state.traySummary.backgroundTasks.pendingConfirmation} 个高风险动作`} tag="处理" tone="warn" />
          <Row
            title="后台执行"
            sub={state.traySummary.backgroundPaused ? '后台执行已暂停' : '当前允许工作区内低风险任务'}
            tag={state.traySummary.backgroundPaused ? '恢复' : '暂停'}
            tone="info"
          />
        </div>
      </div>
      <div className="floating-entry-actions">
        <button
          data-testid="tray-toggle-background"
          type="button"
          onClick={() => {
            const action = state.traySummary.backgroundPaused
              ? window.roc.lifecycle.resumeBackgroundExecution()
              : window.roc.lifecycle.pauseBackgroundExecution();
            void action.then((result) => updateLoadedState({ traySummary: unwrap<TraySummary>('tray background toggle', result) }));
          }}
        >
          {state.traySummary.backgroundPaused ? '恢复后台执行' : '暂停后台执行'}
        </button>
        <button data-testid="tray-open-tasks" type="button" onClick={() => void window.roc.app.openMainPage('tasks')}>
          打开任务
        </button>
      </div>
    </section>
  );
}
