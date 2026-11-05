import type {ResearchExperimentResultReceipt} from '../../../shared/schemas/research-experiment-results';

export function ExperimentResultReceipt({receipt}: {receipt: ResearchExperimentResultReceipt}): React.JSX.Element {
  const {snapshot,snapshotHash}=receipt,{execution,result,request}=snapshot;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-experiment-result-receipt">
    <p className="break-all">结果 {snapshot.id}</p>
    <p className="break-all text-muted">运行 {execution.runId}</p>
    <p className="break-all font-mono text-muted text-[var(--font-meta-size)]">回执 SHA-256 {snapshotHash}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
      <dt>分析脚本</dt><dd className="break-all">{execution.source.path}</dd>
      <dt>脚本 SHA-256</dt><dd className="break-all font-mono">{execution.source.sha256}</dd>
      <dt>实际输出</dt><dd className="break-all">{execution.output.path}</dd>
      <dt>输出 SHA-256</dt><dd className="break-all font-mono">{execution.output.sha256}</dd>
      <dt>环境 SHA-256</dt><dd className="break-all font-mono">{execution.environmentHash}</dd>
      <dt>随机种子</dt><dd>{execution.seed===null?'未记录':execution.seed}</dd>
      <dt>审核人</dt><dd className="break-all">{snapshot.actor.id}</dd>
      <dt>审核时间</dt><dd>{snapshot.recordedAt}</dd>
    </dl>
    <ul className="flex flex-col gap-2">{result.metrics.map(metric=>{
      const definition=request.definitions.find(value=>value.id===metric.id)!;
      return <li key={metric.id} className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line pt-2" data-testid="artifact-experiment-metric">
        <h3 className="font-medium break-words">{definition.label} <span className="text-muted">{metric.id}</span></h3>
        <p className="break-words">{definition.definition}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 tabular-nums">
          <dt>指标值</dt><dd>{metric.value} {metric.unit}</dd>
          <dt>样本量</dt><dd>{metric.sampleSize}</dd>
          <dt>误差</dt><dd className="break-words">{metric.uncertainty.kind==='recorded'?
            `${metric.uncertainty.type==='standard_deviation'?'标准差':'标准误'} ${metric.uncertainty.value} ${metric.unit}`:
            `未估计：${metric.uncertainty.reason}`}</dd>
          <dt>置信区间</dt><dd className="break-words">{metric.confidenceInterval.kind==='recorded'?
            `${metric.confidenceInterval.confidence*100}% [${metric.confidenceInterval.lower}, ${metric.confidenceInterval.upper}] ${metric.unit}`:
            `未估计：${metric.confidenceInterval.reason}`}</dd>
          <dt>效应量</dt><dd className="break-words">{metric.effect.kind==='recorded'?
            `${metric.effect.name} ${metric.effect.value} ${metric.effect.unit}`:`未估计：${metric.effect.reason}`}</dd>
          <dt>指标方向</dt><dd>{{higher:'越高越好',lower:'越低越好',neutral:'中性'}[definition.direction]}</dd>
        </dl>
      </li>;
    })}</ul>
    <section className="flex flex-col gap-1 border-t-[0.5px] border-line pt-2">
      <h3 className="font-medium">人工确认的统计方法</h3>
      <p className="break-words">{request.method.name}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt>选择理由</dt><dd className="break-words">{request.method.rationale}</dd>
        <dt>方法假设</dt><dd className="break-words">{request.method.assumptions}</dd>
        <dt>分析限制</dt><dd className="break-words">{request.method.limitations}</dd>
      </dl>
    </section>
    <details><summary className="cursor-pointer text-muted">完整输入、参数和审核回执</summary>
      <pre tabIndex={0} className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(receipt,null,2)}</pre>
    </details>
  </section>;
}
