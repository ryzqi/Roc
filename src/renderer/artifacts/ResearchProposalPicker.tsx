import {useLayoutEffect, useRef, useState} from 'react';
import type {ResearchProposalCreate, ResearchProposalInspection, ResearchProposalReject} from '../../shared/schemas/research-proposals';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {useArtifactEditorStatus} from './artifact-editor-guard';

type Proposal = ResearchProposalCreate['proposal'];
type Props = {
  client: RocClient; projectId: string; artifactId: string; artifactVersion: string;
  kind: Proposal['kind']; targetKey?: string; disabled: boolean;
  matches?: (proposal: Proposal) => boolean; onPick: (proposal: Proposal) => void;
};
const button = `${formSecondaryButtonClass} border-[0.5px]`;
const pageSize = 10;

/** A proposal populates the existing human form; it never calls a domain save operation. */
export function ResearchProposalPicker(props: Props): React.JSX.Element {
  return <ProposalPicker key={JSON.stringify([props.projectId, props.artifactId, props.artifactVersion, props.kind, props.targetKey])} {...props}/>;
}

function ProposalPicker(props: Props): React.JSX.Element {
  const {client, projectId, artifactId, artifactVersion, kind, disabled, matches} = props;
  const [offset, setOffset] = useState<number | null>(null);
  const [selected, setSelected] = useState<ResearchProposalInspection | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null), [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const current = useRef(props), mounted = useRef(true), busy = useRef(false), rejectingBusy = useRef(false);
  const requests = useRef(new Map<string, string>());
  current.current = props;
  useLayoutEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const {locked, isLocked} = useArtifactEditorStatus({label: '科研提案', dirty: false, pending: () => rejectingBusy.current});
  const list = useAsyncResource(offset === null ? null : `proposals:${projectId}:${artifactId}:${artifactVersion}:${kind}:${offset}`,
    () => client.api.research.listResearchProposals({projectId, artifactId, kind, offset: offset!, limit: pageSize}),
    {label: '读取科研提案'});
  const get = useAsyncAction((proposalId: string) => client.api.research.getResearchProposal({projectId, proposalId}),
    {label: '核对提案版本'});
  const reject = useAsyncAction((request: ResearchProposalReject) => client.api.research.rejectResearchProposal(request),
    {label: '拒绝科研提案'});
  const pending = get.pending || reject.pending;
  const relevant = (item: ResearchProposalInspection): boolean => item.snapshot.request.projectId === projectId &&
    item.snapshot.request.artifactId === artifactId && item.snapshot.request.proposal.kind === kind &&
    (matches?.(item.snapshot.request.proposal) ?? true);
  const items = list.status === 'ready' ? list.data?.items.filter(relevant) ?? [] : [];
  const refresh = (): void => {setSelected(null); setRejecting(null); setReason(''); setMessage(null); list.reload();};
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-proposal-picker" aria-label="Agent 科研提案">
    <button type="button" className={`${button} self-start`} disabled={pending || list.status === 'loading'}
      data-testid="artifact-proposal-load"
      onClick={() => {if (offset === null) setOffset(0); else refresh();}}>
      {offset === null ? '读取 Agent 提案' : '刷新提案'}
    </button>
    {list.status === 'loading' ? <p role="status">正在读取提案…</p> : null}
    {list.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{list.error}</p>}
    {list.status !== 'ready' || list.data === null || offset === null ? null : <>
      {items.length !== 0 ? null : <p className="text-muted">本页没有适用于当前表单的提案。</p>}
      <ul className="flex min-w-0 flex-col gap-3">{items.map(stored => {
        const item = selected?.snapshot.id === stored.snapshot.id ? selected : stored;
        const request = item.snapshot.request;
        const stale = item.freshness !== 'current' || request.expectedArtifactVersion !== artifactVersion;
        const inactive = item.status !== 'pending';
        return <li key={item.snapshot.id} className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2"
          data-testid="artifact-proposal-item">
          <p className="whitespace-pre-wrap break-words">{request.rationale}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted">
            <span>{inactive ? '已拒绝' : stale ? '来源已变化' : '待人工核对'}</span>
            <time className="tabular-nums" dateTime={item.snapshot.recordedAt}>{new Date(item.snapshot.recordedAt).toLocaleString()}</time>
          </div>
          <details className="min-w-0 text-muted"><summary className="cursor-pointer">来源与依据</summary>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt>提案</dt><dd className="break-all">{item.snapshot.id}</dd>
              <dt>助手运行</dt><dd className="break-all">{item.snapshot.origin.runId}</dd>
              <dt>目标工件</dt><dd className="break-all">{request.artifactId}</dd>
              <dt>基准版本</dt><dd className="break-all">{request.expectedArtifactVersion}</dd>
            </dl>
            {request.basis.length === 0 ? null : <ul className="mt-2 flex flex-col gap-1">{request.basis.map(basis =>
              <li key={basis.artifactId} className="break-all">依据工件 {basis.artifactId}，版本 {basis.expectedVersion}</li>)}</ul>}
            {item.staleReasons.map((value, index) => <p key={`${value.artifactId}:${index}`} className="break-words">
              {value.artifactId}：{value.reason}</p>)}
          </details>
          {item.rejection === null ? null : <p className="whitespace-pre-wrap break-words text-muted">拒绝理由：{item.rejection.request.reason}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={disabled || locked || pending || stale || inactive || rejecting !== null}
              data-testid="artifact-proposal-fill" onClick={() => {
                if (current.current.disabled || isLocked() || busy.current) return;
                busy.current = true; setMessage(null);
                void get.run(item.snapshot.id).then(reply => {
                  busy.current = false;
                  if (!mounted.current || !reply.ok) return;
                  if (reply.data.snapshot.id !== item.snapshot.id || !relevant(reply.data) || reply.data.snapshotHash !== item.snapshotHash) {
                    setMessage('提案或来源已变化，请刷新后重新核对。'); return;
                  }
                  setSelected(reply.data);
                  if (reply.data.status !== 'pending' || reply.data.freshness !== 'current' ||
                      reply.data.snapshot.request.expectedArtifactVersion !== artifactVersion) return;
                  if (current.current.disabled || isLocked()) {setMessage('表单状态已变化，请先处理当前修改。'); return;}
                  current.current.onPick(reply.data.snapshot.request.proposal);
                  setMessage('已填入审核草稿');
                });
              }}>核对版本并填入表单</button>
            <button type="button" className={button} disabled={disabled || locked || pending || inactive || rejecting !== null}
              data-testid="artifact-proposal-reject-open" onClick={() => {setRejecting(item.snapshot.id); setReason('');}}>拒绝提案</button>
          </div>
          {rejecting !== item.snapshot.id ? null : <div className="flex min-w-0 flex-col gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-muted">拒绝提案理由
              <textarea rows={2} maxLength={4000} className={`${formInputClass} h-auto resize-y border-[0.5px]`}
                disabled={disabled || pending} value={reason} onChange={event => setReason(event.target.value)}/>
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={disabled || locked || pending || reason.trim().length === 0}
                data-testid="artifact-proposal-reject" onClick={() => {
                  const note = reason.trim();
                  if (current.current.disabled || isLocked() || busy.current || note === '') return;
                  const signature = JSON.stringify([item.snapshot.id, item.snapshotHash, note]);
                  let requestId = requests.current.get(signature);
                  if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
                  busy.current = true; rejectingBusy.current = true;
                  void reject.run({projectId, proposalId: item.snapshot.id, expectedHash: item.snapshotHash, requestId, reason: note}).then(reply => {
                    busy.current = false; rejectingBusy.current = false;
                    if (!mounted.current || !reply.ok) return;
                    setSelected(reply.data); setRejecting(null); setReason('');
                  });
                }}>确认拒绝</button>
              <button type="button" className={button} disabled={pending} onClick={() => {setRejecting(null); setReason('');}}>取消</button>
            </div>
          </div>}
        </li>;
      })}</ul>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted tabular-nums">共 {list.data.total.toLocaleString()} 项</span>
        <button type="button" className={button} disabled={pending || offset === 0} onClick={() => {
          setSelected(null); setRejecting(null); setReason(''); setOffset(offset - pageSize);
        }}>上一页提案</button>
        <button type="button" className={button} disabled={pending || offset + pageSize >= list.data.total} onClick={() => {
          setSelected(null); setRejecting(null); setReason(''); setOffset(offset + pageSize);
        }}>下一页提案</button>
      </div>
    </>}
    {pending ? <p role="status">{get.pending ? '正在核对提案…' : '正在保存拒绝决定…'}</p> : null}
    {message === null ? null : <p role="status" className="text-muted">{message}</p>}
    {get.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{get.error}</p>}
    {reject.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{reject.error}</p>}
  </section>;
}
