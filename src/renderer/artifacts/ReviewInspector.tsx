import {useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {ModalShell} from '../shell/ModalShell';
import {formSecondaryButtonClass} from '../shared/form-ui';
import type {ReviewInspectorRequest} from './artifact-interactions';
import type {ReviewProtocolDrafts} from './review-protocol-draft';
import {ReviewProtocolEditor} from './ReviewProtocolEditor';
import {ReviewSearchCorpus} from './ReviewSearchCorpus';
import {ReviewReadonlyContent} from './ReviewReadonlyContent';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
type Selection = {kind: 'new'} | {kind: 'version'; versionId: string} | null;

export function ReviewInspector({client, request, writable, drafts, onClose}: {
  client: RocClient; request: ReviewInspectorRequest; writable: boolean; drafts: ReviewProtocolDrafts; onClose: () => void
}): React.JSX.Element {
  const [selection, setSelection] = useState<Selection>(() => request.mode === 'readonly' || request.versionId === null ? null :
    {kind: 'version', versionId: request.versionId});
  const [protocolPending, setProtocolPending] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const pending = protocolPending || searchPending;
  const protocols = useAsyncResource(request.mode === 'readonly' ? null : `review:protocols:${request.projectId}`,
    () => client.api.research.listReviewProtocols({projectId: request.projectId, limit: 100}), {label: '读取综述协议'});
  const versionId = selection?.kind === 'version' ? selection.versionId : null;
  const protocol = useAsyncResource(versionId === null ? null : `review:protocol:${request.projectId}:${versionId}`,
    () => {
      if (versionId === null) throw new Error('research_review_protocol_required');
      return client.api.research.getReviewProtocol({projectId: request.projectId, versionId});
    }, {label: '读取协议版本'});
  const current = protocol.status === 'ready' ? protocol.data : null;
  const history = useAsyncResource(current === null ? null :
    `review:history:${request.projectId}:${current.version.protocolId}:${current.versionHash}:${current.freezeHash}`,
    () => {
      if (current === null) throw new Error('research_review_protocol_required');
      return client.api.research.getReviewProtocolHistory({projectId: request.projectId, protocolId: current.version.protocolId});
    }, {label: '读取协议修订历史'});
  return <ModalShell open kind="drawer" title="综述核查" onClose={onClose} beforeClose={() => !pending}
    widthClassName="w-[560px]" testId="artifact-inspector">
    <div className="flex min-w-0 flex-col gap-3 text-[length:var(--font-body-size)]" data-testid="artifact-review">
      {request.mode === 'readonly' ? <ReviewReadonlyContent client={client} link={request} /> : <>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={pending || protocols.status === 'loading' || protocol.status === 'loading'}
          data-testid="artifact-review-refresh" onClick={() => {protocols.reload(); protocol.reload();}}>刷新综述</button>
        <button type="button" className={button} disabled={!writable || pending} data-testid="artifact-review-new"
          onClick={() => setSelection({kind: 'new'})}>新建协议</button>
      </div>
      {!writable ? <p role="note">项目已归档，综述仅可阅读。</p> : null}
      {pending ? <p role="status">正在保存人工操作…</p> : null}
      {protocols.status === 'loading' ? <p role="status">正在读取综述协议…</p> : null}
      {protocols.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{protocols.error}</p>}
      {protocols.status !== 'ready' ? null : <section className="flex flex-col gap-1" aria-label="最近100份综述协议">
        {protocols.data!.length === 0 ? <p className="text-muted">尚无综述协议。</p> :
          <ul className="flex flex-col gap-1">{protocols.data!.map(item => <li key={item.version.protocolId}>
            <button type="button" className={`${button} h-auto w-full py-1 text-left break-words`}
              disabled={pending} aria-pressed={item.version.id === versionId}
              data-testid="artifact-review-protocol" onClick={() => setSelection({kind: 'version', versionId: item.version.id})}>
              {item.version.body.question}<span className="ml-2 text-subtle">版本 {item.version.version}
                {item.freeze === null ? ' 草稿' : ' 已冻结'}</span>
            </button>
          </li>)}</ul>}
      </section>}
      {protocol.status === 'loading' ? <p role="status">正在读取协议版本…</p> : null}
      {protocol.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{protocol.error}</p>}
      {current === null ? null : <section className="flex flex-col gap-1 border-t-[0.5px] border-line pt-2">
        <h2 className="font-medium">修订历史</h2>
        {history.status === 'loading' ? <p role="status">正在读取修订历史…</p> : null}
        {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
        {history.status !== 'ready' ? null : <ul className="flex flex-col gap-1">
          {history.data!.map(item => <li key={item.version.id}>
            <button type="button" className={button} disabled={pending} aria-pressed={item.version.id === versionId}
              data-testid="artifact-review-history-version" onClick={() => setSelection({kind: 'version', versionId: item.version.id})}>
              版本 {item.version.version}{item.freeze === null ? ' 草稿' : ' 已冻结'}{item.isLatest ? ' 当前' : ''}
            </button>
            <span className="ml-2 break-words text-muted">{item.version.deviationReason}</span>
          </li>)}
        </ul>}
      </section>}
      {current?.freeze === null || current === null ? null :
        <ReviewSearchCorpus key={`search:${current.version.id}:${current.freezeHash}`} client={client} protocol={current}
          writable={writable && !protocolPending} onPending={setSearchPending} />}
      {selection?.kind === 'new' || current !== null ?
        <ReviewProtocolEditor key={current === null ? 'protocol:new' : `protocol:${current.version.id}:${current.freezeHash}`}
          client={client} projectId={request.projectId} current={current} writable={writable && !searchPending} drafts={drafts}
          onPending={setProtocolPending} onSaved={saved => {
            setSelection({kind: 'version', versionId: saved.version.id});
            protocols.reload(); protocol.reload();
          }} /> : null}
      </>}
    </div>
  </ModalShell>;
}
