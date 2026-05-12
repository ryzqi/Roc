import type { PerformanceSample } from '../../../shared/types';
import { Row } from '../../components/Row';

export function PerformancePanel({ performanceSample }: { performanceSample: PerformanceSample }): React.JSX.Element {
  return (
    <section className="card" data-testid="performance-sample">
      <div className="card-title">性能采样</div>
      <Row title="RSS" sub={`${performanceSample.rssMb} MB`} tag={performanceSample.exceedsBudget ? '超预算' : '正常'} tone={performanceSample.exceedsBudget ? 'warn' : 'ok'} />
      <Row title="Heap" sub={`${performanceSample.heapUsedMb} / ${performanceSample.heapTotalMb} MB`} tag="sample" tone="info" />
      <Row title="预算" sub={`${performanceSample.memoryBudgetMb} MB`} tag={performanceSample.mode} tone="info" />
    </section>
  );
}
