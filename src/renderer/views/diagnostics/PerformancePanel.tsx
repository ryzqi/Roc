import type { PerformanceSample } from '../../../shared/types';
import { Metric } from '../../components/Metric';

export function PerformancePanel({ performanceSample }: { performanceSample: PerformanceSample }): React.JSX.Element {
  const firstTokenSample = [...performanceSample.timing.samples]
    .reverse()
    .find((sample) => sample.phase === 'provider_first_token');
  const completedSample = [...performanceSample.timing.samples]
    .reverse()
    .find((sample) => sample.phase === 'provider_completed');
  const rssNote = performanceSample.exceedsBudget ? '超过 Roc 预算' : 'Electron/Chromium/Node 基线内';

  return (
    <section className="section" data-testid="performance-sample">
      <div className="section-head">
        <h2 className="section-title">性能采样</h2>
      </div>
      <div className="stat-row">
        <Metric label="RSS" note={rssNote} tone={performanceSample.exceedsBudget ? 'warn' : 'neutral'} value={performanceSample.rssMb} />
        <Metric label="Heap" note={`${performanceSample.heapUsedMb} / ${performanceSample.heapTotalMb} MB`} value={performanceSample.heapUsedMb} />
        <Metric label="预算" note={performanceSample.mode} value={performanceSample.memoryBudgetMb} />
        <Metric label="Provider 首 token" note={firstTokenSample?.label ?? '暂无'} value={firstTokenSample === undefined ? 0 : Math.round(firstTokenSample.durationMs)} />
        <Metric label="Provider 完成" note={completedSample?.label ?? '暂无'} value={completedSample === undefined ? 0 : Math.round(completedSample.durationMs)} />
      </div>
    </section>
  );
}
