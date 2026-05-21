import { EmptyState } from '../../components/EmptyState';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import { StatusPill } from '../../components/StatusPill';
import type { LazyLoadState } from '../../app/types';
import { formatBeijingDateTime } from '../../format-time';
import type { LoadedState } from '../../loaded-state';
import { DiagnosticPackagePanel } from './DiagnosticPackagePanel';
import { PerformancePanel } from './PerformancePanel';

export function DiagnosticsView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading title="任务诊断包" />
        <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
          <EmptyState testId="diagnostics-loading" title="诊断数据加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading title="任务诊断包" />
        <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
          <EmptyState testId="diagnostics-load-error" title="诊断数据加载失败" tone="error" />
        </section>
      </>
    );
  }

  const failedEvents = state.taskSnapshot.recentEvents.filter((event) => event.type === 'error').slice(0, 3);
  return (
    <>
      <PageHeading title="任务诊断包" meta={`最近失败 ${failedEvents.length} 条 · task ${state.taskSnapshot.counts.total}`} />
      <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
        <section className="single-panel">
          <div className="section-head">
            <h2 className="section-title">失败任务</h2>
            <StatusPill label="状态" tone="bad" value={failedEvents.length === 0 ? '无失败任务' : '验证失败'} />
          </div>
          <div className="list-rows">
            {failedEvents.length === 0 ? (
              <Row title="失败事件" sub="当前没有失败任务事件。" tag="空" tone="ok" />
            ) : (
              failedEvents.map((event) => (
                <Row key={event.id} title={event.type} sub={formatBeijingDateTime(event.createdAt)} tag="已记录" tone="bad" />
              ))
            )}
            <Row title="关键日志" sub={state.diagnosticPackage === null ? '尚未生成诊断包。' : state.diagnosticPackage.path} tag={state.diagnosticPackage === null ? '空态' : '已生成'} tone={state.diagnosticPackage === null ? 'warn' : 'ok'} />
            <Row title="恢复与脱敏" sub={state.diagnosticPackage === null ? '无诊断包' : state.diagnosticPackage.redacted ? '已脱敏' : '未通过'} tag={state.diagnosticPackage === null ? '空态' : '已检查'} tone={state.diagnosticPackage === null ? 'warn' : state.diagnosticPackage.redacted ? 'ok' : 'bad'} />
            <Row title="包含项" sub={state.diagnosticPackage === null ? '无' : state.diagnosticPackage.includes.join(', ')} tag="task_snapshot" tone="info" />
          </div>
        </section>
        <div className="diagnostics-surface-grid">
          <section className="section" data-testid="diagnostic-checks">
            <div className="section-head">
              <h2 className="section-title">Doctor 检查</h2>
            </div>
            <div className="list-rows">
              {state.diagnosticChecks.length === 0 ? (
                <Row title="调度检查" sub="尚未运行检查。" tag="空" tone="warn" />
              ) : (
                state.diagnosticChecks.map((check) => (
                  <Row
                    key={check.id}
                    title={check.label}
                    sub={check.message}
                    tag={check.status}
                    tone={check.severity === 'error' ? 'bad' : check.severity === 'warning' ? 'warn' : 'ok'}
                  />
                ))
              )}
            </div>
          </section>
          <DiagnosticPackagePanel diagnosticPackage={state.diagnosticPackage} />
          <PerformancePanel performanceSample={state.performanceSample} />
        </div>
      </section>
    </>
  );
}
