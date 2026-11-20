import type {ResearchFigureConsistencyReceipt} from '../../shared/schemas/research-figure-consistency';

export function FigureConsistencyReceipt({receipt}: {receipt: ResearchFigureConsistencyReceipt}): React.JSX.Element {
  const {snapshot, snapshotHash} = receipt;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-figure-consistency-receipt">
    <h3 className="font-medium">图稿数据审核，第 {snapshot.version} 版</h3>
    <p className="whitespace-pre-wrap break-words">{snapshot.request.rationale}</p>
    <p className="break-all text-muted">{snapshot.actor.id}，{snapshot.recordedAt}，SHA-256 {snapshotHash}</p>
    {snapshot.material.mappings.map((mapping, index) => {
      const binding = snapshot.request.bindings[index], value = mapping.calculation;
      return <div key={JSON.stringify([binding.markName, binding.channel, binding.scenePath])} className="min-w-0 break-words">
        <p>{binding.field}：{value.observedText} {binding.unit}，期望 {value.expectedText} {binding.unit}，
          {value.consistent ? '数值一致' : '数值不一致'}，差异 {value.difference}，允许 {value.allowedDifference}</p>
        <p className="whitespace-pre-wrap">{mapping.claim.content}</p>
        <details className="text-muted"><summary className="cursor-pointer">来源指标、场景位置与规则</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify({binding, mapping}, null, 2)}</pre>
        </details>
      </div>;
    })}
    <details className="text-muted"><summary className="cursor-pointer">图稿审核回执原文</summary>
      <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify(receipt, null, 2)}</pre>
    </details>
  </section>;
}
