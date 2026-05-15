import type { PerformanceSample } from '../../../shared/types';
import { Row } from '../../components/Row';

export function PerformancePanel({ performanceSample }: { performanceSample: PerformanceSample }): React.JSX.Element {
  return (
    <section className="section" data-testid="performance-sample">
      <div className="section-head">
        <h2 className="section-title">性能采样</h2>
      </div>
      <div className="stat-row">
        <div className={`metric${performanceSample.exceedsBudget ? ' metric--warn' : ' metric--ok'}`}>
          <strong>{performanceSample.rssMb}</strong>
          <span>RSS</span>
          <small>{performanceSample.exceedsBudget ? '超预算' : '正常'}</small>
        </div>
        <div className="metric">
          <strong>{performanceSample.heapUsedMb}</strong>
          <span>Heap</span>
          <small>{`${performanceSample.heapUsedMb} / ${performanceSample.heapTotalMb} MB`}</small>
        </div>
        <div className="metric">
          <strong>{performanceSample.memoryBudgetMb}</strong>
          <span>预算</span>
          <small>{performanceSample.mode}</small>
        </div>
      </div>
    </section>
  );
}
