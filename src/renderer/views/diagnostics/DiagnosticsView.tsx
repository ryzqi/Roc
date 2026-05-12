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
        <PageHeading kicker="控制面" title="任务诊断包" />
        <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
          <EmptyState testId="diagnostics-loading" title="诊断数据加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="控制面" title="任务诊断包" />
        <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
          <EmptyState testId="diagnostics-load-error" title="诊断数据加载失败" tone="error" />
        </section>
      </>
    );
  }

  const failedEvents = state.taskSnapshot.recentEvents.filter((event) => event.type === 'error').slice(0, 3);
  return (
    <>
      <PageHeading kicker="控制面" title="任务诊断包" />
      <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
        <section className="card">
          <div className="card-title">失败任务 <StatusPill label="状态" tone="bad" value={failedEvents.length === 0 ? '无失败任务' : '验证失败'} /></div>
          {failedEvents.length === 0 ? (
            <Row title="失败事件" sub="当前没有失败任务事件。" tag="空" tone="ok" />
          ) : (
            failedEvents.map((event) => (
              <Row key={event.id} title={event.type} sub={formatBeijingDateTime(event.createdAt)} tag="已记录" tone="bad" />
            ))
          )}
        </section>
        <div className="grid-2">
          <section className="card">
            <div className="card-title">关键日志</div>
            <Row title="诊断包" sub={state.diagnosticPackage === null ? '尚未生成诊断包。' : state.diagnosticPackage.path} tag={state.diagnosticPackage === null ? '空态' : '已生成'} tone={state.diagnosticPackage === null ? 'warn' : 'ok'} />
            <Row title="性能采样" sub={`${state.performanceSample.rssMb} MB RSS`} tag={state.performanceSample.exceedsBudget ? '超预算' : '正常'} tone={state.performanceSample.exceedsBudget ? 'warn' : 'ok'} />
          </section>
          <section className="card">
            <div className="card-title">恢复与脱敏</div>
            <Row title="脱敏状态" sub={state.diagnosticPackage === null ? '无诊断包' : state.diagnosticPackage.redacted ? '已脱敏' : '未通过'} tag={state.diagnosticPackage === null ? '空态' : '已检查'} tone={state.diagnosticPackage === null ? 'warn' : state.diagnosticPackage.redacted ? 'ok' : 'bad'} />
            <Row title="包含项" sub={state.diagnosticPackage === null ? '无' : state.diagnosticPackage.includes.join(', ')} tag="真实数据" tone="info" />
          </section>
        </div>
        <div className="grid-2">
          <DiagnosticPackagePanel diagnosticPackage={state.diagnosticPackage} />
          <PerformancePanel performanceSample={state.performanceSample} />
        </div>
      </section>
    </>
  );
}
