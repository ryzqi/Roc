import type {ResearchIdeaOutcomeReceipt as Receipt, ResearchIdeaOutcomeSave} from '../../shared/schemas/research-idea-outcomes';
import {ExperimentResultReceipt} from './production/ExperimentResultReceipt';

export const outcomeVerdicts: Record<ResearchIdeaOutcomeSave['verdict'], string> = {
  supports: '支持假设', contradicts: '反驳假设', inconclusive: '结果不确定', not_comparable: '不可比'
};
const differenceLabels = {missing_metric: '缺失指标', definition: '定义', unit: '单位', direction: '方向'};

export function IdeaOutcomeReceipt({receipt}: {receipt: Receipt}): React.JSX.Element {
  const {snapshot, snapshotHash} = receipt, {request, material} = snapshot;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-idea-outcome-receipt">
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt>人工评估</dt><dd>{outcomeVerdicts[request.verdict]}</dd>
      <dt>评估版本</dt><dd>{snapshot.version}</dd>
      <dt>审核人</dt><dd className="break-all">{snapshot.actor.id}</dd>
      <dt>记录时间</dt><dd>{snapshot.recordedAt}</dd>
      <dt>冻结假设</dt><dd className="break-words">{material.plan.version.request.body.hypothesis}</dd>
      <dt>实际运行时间</dt><dd className="break-words">{material.executionTime.startedAt} — {material.executionTime.endedAt}</dd>
      <dt>审核说明</dt><dd className="break-words">{request.reviewNote}</dd>
      {request.revisionReason === null ? null : <><dt>修订原因</dt><dd className="break-words">{request.revisionReason}</dd></>}
    </dl>
    <p className="break-all font-mono text-muted text-[var(--font-meta-size)]">评估 SHA-256 {snapshotHash}</p>
    <p className="break-all font-mono text-muted text-[var(--font-meta-size)]">冻结 SHA-256 {material.plan.freezeHash}</p>
    <ul className="flex flex-col gap-2">{request.metrics.map(mapping => {
      const planned = material.plan.version.request.body.metrics.find(metric => metric.id === mapping.plannedMetricId)!;
      const differences = material.differences.find(item => item.plannedMetricId === mapping.plannedMetricId);
      return <li key={mapping.plannedMetricId} className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium break-words">{planned.label} {planned.id}</h3>
        <p className="break-words">预期结果：{planned.expectedOutcome}</p>
        <p className="break-words">{mapping.kind === 'missing' ? `未测量：${mapping.reason}` : `指标证据：${mapping.evidenceId}`}</p>
        {differences === undefined ? null : <p className="break-words text-[var(--st-warn)]">
          不可比项：{differences.fields.map(field => differenceLabels[field]).join('、')}
        </p>}
      </li>;
    })}</ul>
    <details><summary className="cursor-pointer">保存的实际结果与统计方法</summary>
      <div className="mt-2"><ExperimentResultReceipt receipt={material.result}/></div>
    </details>
    <details><summary className="cursor-pointer text-muted">完整冻结方法、证据与评估回执</summary>
      <pre tabIndex={0} className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">
        {JSON.stringify(receipt, null, 2)}
      </pre>
    </details>
  </section>;
}
