import {useEffect, useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ResponseMatrixReceipt, responseStatusLabels} from './ResponseMatrixReceipt';
import {ResponseMatrixEditor} from './ResponseMatrixEditor';

const button = `${formSecondaryButtonClass} border-[0.5px]`, pageSize = 10;
export function ArtifactResponseMatrix({client, snapshot, writable, locked: externalLocked, onDirty, onPending, onSaved}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; writable: boolean; locked: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const baseline = useRef<string | null>(null);
  const [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false), [pending, setPending] = useState(false);
  const [offset, setOffset] = useState<number | null>(null);
  const {projectId, id: artifactId} = snapshot.artifact;
  const locked = externalLocked || dirty || pending;
  const read = useAsyncResource(`response:inspect:${projectId}:${artifactId}:${snapshot.version}`,
    () => client.api.research.inspectResponseMatrix({projectId, artifactId, expectedHash: baseline.current}), {label: '检查审稿回复'});
  const result = read.status === 'ready' ? read.data : null;
  const history = useAsyncResource(offset === null ? null : `response:history:${projectId}:${artifactId}:${snapshot.version}:${offset}`,
    () => client.api.research.getResponseMatrixHistory({projectId, artifactId, offset: offset!, limit: pageSize}), {label: '读取审稿矩阵历史'});
  useEffect(() => {if (result?.status === 'current') baseline.current = result.reportHash;}, [result]);
  const matchesArtifact = result !== null && result.report.artifactVersion === snapshot.version;
  return <section className="mt-2 flex min-w-0 flex-col gap-3" data-testid="artifact-response-matrix" aria-label="审稿意见与回复">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-medium">审稿意见与回复</h2>
      <button type="button" className={button} disabled={locked || read.status === 'loading'} data-testid="artifact-response-refresh"
        onClick={() => {setEditing(false); read.reload();}}>重新检查回复</button>
    </div>
    {read.status === 'loading' ? <p role="status">正在核对修改稿与审稿回复…</p> : null}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
    {result !== null && !matchesArtifact ? <p role="alert" className="text-[var(--st-warn)]" data-testid="artifact-response-artifact-changed">
      工件已变化，请先刷新工件。
    </p> : null}
    {result === null || !matchesArtifact ? null : <>
      {result.status !== 'stale' ? null : <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-[var(--st-warn)]">审稿回复报告已变化，请核对当前版本。</p>
        <button type="button" className={button} disabled={locked} data-testid="artifact-response-recapture"
          onClick={() => {setEditing(false); baseline.current = result.reportHash; read.reload();}}>按当前版本核对回复</button>
      </div>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted tabular-nums">
        <dt>未处理</dt><dd>{result.report.openCommentIds.length}</dd>
        <dt>{result.report.reviewCurrent ? '已处理' : '历史已处理'}</dt><dd>{result.report.addressedCommentIds.length}</dd>
        <dt>{result.report.reviewCurrent ? '未采纳' : '历史未采纳'}</dt><dd>{result.report.declinedCommentIds.length}</dd>
        <dt>报告 SHA-256</dt><dd className="break-all font-mono text-[var(--font-meta-size)]" data-testid="artifact-response-hash">{result.reportHash}</dd>
      </dl>
      {result.report.review === null ? <p className="text-muted">尚无保存的审稿矩阵。</p> : <>
        {!result.report.reviewCurrent ? <p role="alert" className="text-[var(--st-warn)]" data-testid="artifact-response-source-changed">
          修改稿或证据已变化。以下为历史人工判断，需要重新核对。
        </p> : <p className="text-muted">人工回复已绑定当前修改稿；论文接受仍需人工决定。</p>}
        <ul className="flex min-w-0 flex-col gap-2" data-testid="artifact-response-comments">
          {result.report.review.snapshot.request.rows.map(row => <li className="whitespace-pre-wrap break-words" key={row.commentId}>
            {row.reviewer}，{responseStatusLabels[row.status]}{result.report.reviewCurrent ? '' : '（历史判断）'}：{row.comment}
          </li>)}
        </ul>
        <ResponseMatrixReceipt receipt={result.report.review}/>
      </>}
      <button type="button" className={`${button} self-start`} disabled={locked || result.status !== 'current'}
        data-testid="artifact-response-edit" onClick={() => setEditing(value => !value)}>{editing ? '收起矩阵编辑' : '编辑审稿矩阵'}</button>
      {!editing ? null : <ResponseMatrixEditor key={result.reportHash} client={client} snapshot={snapshot} report={result.report}
        writable={writable && !externalLocked && result.status === 'current'}
        onDirty={value => {setDirty(value); onDirty(value);}} onPending={value => {setPending(value); onPending(value);}} onSaved={onSaved}/>}
    </>}
    <button type="button" className={`${button} self-start`} disabled={locked || history.status === 'loading'}
      data-testid="artifact-response-history-open" onClick={() => {if (offset === 0) history.reload(); else setOffset(0);}}>读取审稿矩阵历史</button>
    {history.status === 'loading' ? <p role="status">正在读取保存的矩阵历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null || offset === null ? null : <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-response-history">
      <p className="text-muted">保存回执，共 {history.data.total} 版。历史来源未按当前版本复核。</p>
      {history.data.items.map(receipt => <ResponseMatrixReceipt key={receipt.snapshot.id} receipt={receipt}/>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={locked || offset === 0} data-testid="artifact-response-history-prev"
          onClick={() => setOffset(offset - pageSize)}>上一页矩阵</button>
        <button type="button" className={button} disabled={locked || offset + pageSize >= history.data.total} data-testid="artifact-response-history-next"
          onClick={() => setOffset(offset + pageSize)}>下一页矩阵</button>
      </div>
    </section>}
  </section>;
}
