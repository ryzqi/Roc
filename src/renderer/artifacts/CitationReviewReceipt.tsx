import type {ResearchCitationReviewReceipt} from '../../shared/schemas/research-citation-reviews';

export const directnessLabels = {direct: '直接引用', indirect: '间接引用', unsupported: '不支持该主张'};

export function CitationReviewReceipt({receipt}: {receipt: ResearchCitationReviewReceipt}): React.JSX.Element {
  const {snapshot, snapshotHash} = receipt;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-citation-review-receipt">
    <p className="break-words font-medium">{directnessLabels[snapshot.request.directness]}，审核版本 {snapshot.version}</p>
    <p className="whitespace-pre-wrap break-words">{snapshot.request.rationale}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
      <dt>审核人</dt><dd className="break-words">{snapshot.actor.id}</dd>
      <dt>保存时间</dt><dd className="break-words">{snapshot.recordedAt}</dd>
      <dt>审核 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]">{snapshotHash}</dd>
    </dl>
    <details className="min-w-0 text-muted">
      <summary className="cursor-pointer">完整审核回执与保存的主张、来源</summary>
      <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify(receipt, null, 2)}</pre>
    </details>
  </section>;
}
