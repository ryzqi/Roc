import type { PerformanceSample } from '../../../shared/types';
import { Metric } from '../../components/Metric';

export function PerformancePanel({ performanceSample }: { performanceSample: PerformanceSample }): React.JSX.Element {
  return (
    <section className="section" data-testid="performance-sample">
      <div className="section-head">
        <h2 className="section-title">性能采样</h2>
      </div>
      <div className="stat-row">
        <Metric label="RSS" note={performanceSample.exceedsBudget ? '超预算' : '正常'} tone={performanceSample.exceedsBudget ? 'warn' : 'ok'} value={performanceSample.rssMb} />
        <Metric label="Heap" note={`${performanceSample.heapUsedMb} / ${performanceSample.heapTotalMb} MB`} value={performanceSample.heapUsedMb} />
        <Metric label="预算" note={performanceSample.mode} value={performanceSample.memoryBudgetMb} />
      </div>
    </section>
  );
}
