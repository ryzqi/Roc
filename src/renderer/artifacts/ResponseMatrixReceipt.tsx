import type {ResearchResponseMatrixReceipt} from '../../shared/schemas/research-response-matrix';

export const responseStatusLabels = {open: '未处理', addressed: '已处理', declined: '未采纳'};
export function ResponseMatrixReceipt({receipt}: {receipt: ResearchResponseMatrixReceipt}): React.JSX.Element {
  const {snapshot, snapshotHash} = receipt;
  return <details className="min-w-0 text-muted" data-testid="artifact-response-receipt">
    <summary className="cursor-pointer">保存回执，第 {snapshot.version} 版，{snapshot.recordedAt}</summary>
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      <p className="break-words">{snapshot.actor.id}：{snapshot.request.rationale}</p>
      <p className="break-all font-mono text-[var(--font-meta-size)]">SHA-256 {snapshotHash}</p>
      <p className="break-all">修改稿 {snapshot.material.manuscript.contentHash}</p>
      <ul className="flex min-w-0 flex-col gap-2">
        {snapshot.request.rows.map(row => <li className="whitespace-pre-wrap break-words" key={row.commentId}>
          <p>{row.reviewer}，{responseStatusLabels[row.status]}：{row.comment}</p>
          <p>回复：{row.response.length === 0 ? '尚未填写' : row.response}</p>
          {row.locations.map(location => <p key={`${location.claimId}:${location.start}:${location.end}`}>
            修改位置 {location.claimId}，字符 {location.start}–{location.end}：{location.text}
          </p>)}
          <p className="break-all">证据：{row.evidenceIds.length === 0 ? '未关联' : row.evidenceIds.join('，')}</p>
        </li>)}
      </ul>
      <details><summary className="cursor-pointer">完整矩阵回执原文</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(receipt, null, 2)}</pre>
      </details>
    </div>
  </details>;
}
