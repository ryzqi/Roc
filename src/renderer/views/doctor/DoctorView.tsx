import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import type { LazyLoadState } from '../../app/types';
import type { LoadedState } from '../../loaded-state';
import { DiagnosticPackagePanel } from '../diagnostics/DiagnosticPackagePanel';
import { PerformancePanel } from '../diagnostics/PerformancePanel';

export function DoctorView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading kicker="控制面" title="Doctor" />
        <section className="canvas-stage stage-grid" data-testid="doctor-view">
          <EmptyState testId="doctor-loading" title="Doctor 检查中" tone="loading" />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="控制面" title="Doctor" />
        <section className="canvas-stage stage-grid" data-testid="doctor-view">
          <EmptyState testId="doctor-load-error" title="Doctor 加载失败" tone="error" />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading kicker="控制面" title="Doctor" />
      <section className="canvas-stage stage-grid" data-testid="doctor-view">
        <div className="grid-3">
          <Metric label="通过" note="检查项 pass" tone="ok" value={state.doctor.summary.pass} />
          <Metric label="警告 / 降级" note="可执行修复" tone="warn" value={state.doctor.summary.degraded} />
          <Metric label="失败" note="需要用户处理" tone={state.doctor.summary.fail > 0 ? 'bad' : 'ok'} value={state.doctor.summary.fail} />
        </div>
        <section className="card">
          <div className="card-title">健康检查结果</div>
          {state.doctor.findings.map((finding) => (
            <Row
              key={finding.id}
              sub={finding.detail}
              tag={finding.status}
              title={finding.repairAction === undefined ? finding.title : `${finding.title} · ${finding.repairAction.label}`}
              tone={finding.status === 'pass' ? 'ok' : finding.status === 'fail' ? 'bad' : 'warn'}
            />
          ))}
          <Row title="后台任务" sub="打开任务工作台查看后台执行、失败任务和待确认项" tag="打开任务工作台" tone="info" />
        </section>
        <DiagnosticPackagePanel diagnosticPackage={state.diagnosticPackage} />
        <PerformancePanel performanceSample={state.performanceSample} />
      </section>
    </>
  );
}
