import type { PerformanceSample } from '../../../shared/types';
import { Metric } from '../../components/Metric';

export function PerformancePanel({ performanceSample }: { performanceSample: PerformanceSample }): React.JSX.Element {
  const firstTokenSample = findLatestSample(performanceSample.timing.samples, 'provider_first_token');
  const completedSample = findLatestSample(performanceSample.timing.samples, 'provider_completed');
  const privateNote =
    performanceSample.memoryMeasurement === 'complete'
      ? performanceSample.exceedsBudget
        ? '超过 Roc 预算'
        : '全部 Roc 进程'
      : 'private bytes 不可用';

  return (
    <section className="section" data-testid="performance-sample">
      <div className="section-head">
        <h2 className="section-title">性能采样</h2>
      </div>
      <div className="stat-row">
        <Metric
          label="Private"
          note={privateNote}
          tone={performanceSample.exceedsBudget ? 'warn' : 'neutral'}
          value={performanceSample.totalPrivateBytesMb === null ? 0 : performanceSample.totalPrivateBytesMb}
        />
        <Metric label="Working Set" note="全部 Roc 进程" value={performanceSample.totalWorkingSetMb} />
        <Metric label="RSS" note="主进程诊断值" value={performanceSample.rssMb} />
        <Metric label="Heap" note={`${performanceSample.heapUsedMb} / ${performanceSample.heapTotalMb} MB`} value={performanceSample.heapUsedMb} />
        <Metric label="预算" note={performanceSample.mode} value={performanceSample.memoryBudgetMb} />
        <Metric label="Provider 首 token" note={firstTokenSample?.label ?? '暂无'} value={firstTokenSample === undefined ? 0 : Math.round(firstTokenSample.durationMs)} />
        <Metric label="Provider 完成" note={completedSample?.label ?? '暂无'} value={completedSample === undefined ? 0 : Math.round(completedSample.durationMs)} />
      </div>
    </section>
  );
}

function findLatestSample(
  samples: readonly PerformanceSample['timing']['samples'][number][],
  phase: PerformanceSample['timing']['samples'][number]['phase']
): PerformanceSample['timing']['samples'][number] | undefined {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample?.phase === phase) {
      return sample;
    }
  }
  return undefined;
}
