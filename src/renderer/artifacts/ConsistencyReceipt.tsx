import type {ResearchConsistencyReceipt} from '../../shared/schemas/research-consistency';

export const consistencySurfaces = {abstract: '摘要', body: '正文', table: '表格', figure_caption: '图稿说明'};

export function ConsistencyReceipt({receipt}: {receipt: ResearchConsistencyReceipt}): React.JSX.Element {
  const {snapshot, snapshotHash} = receipt;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-consistency-receipt">
    <p className="font-medium">数值审核版本 {snapshot.version}</p>
    <p className="whitespace-pre-wrap break-words">{snapshot.request.rationale}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
      <dt>审核人</dt><dd className="break-words">{snapshot.actor.id}</dd>
      <dt>保存时间</dt><dd className="break-words">{snapshot.recordedAt}</dd>
      <dt>审核 SHA-256</dt><dd className="break-all font-mono text-[var(--font-meta-size)]">{snapshotHash}</dd>
    </dl>
    <ul className="flex min-w-0 flex-col gap-2">
      {snapshot.request.bindings.map((binding, index) => {
        const {claim, calculation} = snapshot.material[index];
        return <li key={`${binding.claimId}:${binding.start}:${binding.end}`} className="min-w-0 break-words">
          <p>{consistencySurfaces[binding.surface]}，{claim.content}</p>
          <p className={calculation.consistent ? 'text-muted' : 'text-[var(--st-warn)]'}>
            {calculation.consistent ? '数值一致' : '数值不一致'}：展示 {calculation.observedText} {binding.unit}，
            期望 {calculation.expectedText} {binding.unit}，差异 {calculation.difference}，允许 {calculation.allowedDifference}
          </p>
          <p className="break-all text-muted">指标 {binding.metricId}，结果 {binding.resultId}，证据 {binding.evidenceId}</p>
        </li>;
      })}
    </ul>
    <details className="min-w-0 text-muted">
      <summary className="cursor-pointer">完整数值审核回执与规则、来源</summary>
      <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(receipt, null, 2)}</pre>
    </details>
  </section>;
}
