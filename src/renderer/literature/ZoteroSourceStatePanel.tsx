import {useState} from 'react';
import {AlertTriangle} from 'lucide-react';
import type {ZoteroReview} from '../../shared/schemas/research-zotero';
import type {ZoteroSourceState} from '../../shared/schemas/research-zotero-source-state';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import type {RocClient} from '../shared/roc-client';
import type {ZoteroAttachmentJobs} from './use-zotero-attachment-jobs';
import {ZoteroAttachmentPanel} from './ZoteroAttachmentPanel';

type Original = NonNullable<ZoteroReview['items'][number]['previousScopedSource']>;
type Props = {client: RocClient; projectId: string | null; collectionKey: string | null; original: Original};

export function ZoteroSourceStatePanel({client, projectId, collectionKey, original}: Props): React.JSX.Element {
  const request = {...original.scope, projectId, operationId: original.operationId, itemKey: original.itemKey, collectionKey};
  const stored = useAsyncResource(`zotero:source-state:${JSON.stringify(request)}`,
    () => client.api.research.readZoteroSourceState(request), {label: '读取来源状态观察'});
  const observe = useAsyncAction(client.api.research.observeZoteroSource, {label: '检查当前来源'});
  const [observed, setObserved] = useState<ZoteroSourceState | null>(null);
  const state = observed ?? stored.data;
  const availability = {present: '来源存在', trashed: '来源在回收站', not_found: '来源未找到'};
  const membership = {not_requested: '未核对集合', listed: '仍在所选集合', not_listed: '已不在所选集合', unknown: '集合成员状态未知'};
  const versions = {missing: '没有当前对象版本', regressed: '对象版本回退', unchanged: '对象版本与内容未变化',
    newer: '对象版本已更新', version_conflict: '同版本内容不同'};

  async function check(): Promise<void> {
    const result = await observe.run(request);
    if (result.ok) setObserved(result.data);
  }

  return <section className="mt-2 flex flex-col gap-2 text-muted" aria-label="当前来源状态" data-testid="literature-zotero-source-state">
    <div className="flex flex-wrap items-center gap-2">
      <span>当前来源状态</span>
      <button type="button" className={`${formSecondaryButtonClass} border-[0.5px]`} disabled={observe.pending || stored.status === 'loading'}
        data-testid="literature-zotero-source-check" onClick={() => void check()}>
        {observe.pending ? '检查中…' : '检查当前来源'}
      </button>
    </div>
    {stored.status === 'loading' && state === null ? <p role="status">正在读取已保存的观察…</p> : null}
    {stored.status === 'ready' && state === null ? <p>尚无来源状态观察。</p> : null}
    {state === null ? null : <div className="flex flex-col gap-1" role="status" data-testid="literature-zotero-source-observation">
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-ink"><span>{availability[state.remote.status]}</span>
        <span>{membership[state.membership]}</span><span>{versions[state.versionState]}</span></p>
      <p>原收录对象版本 {state.importedObjectVersion}，当前对象版本 {state.remote.objectVersion ?? '未知'}</p>
      <p>检查时间 <time dateTime={state.remote.checkedAt}>{state.remote.checkedAt}</time></p>
      {state.remote.status === 'not_found' ? <p>本次未找到来源，不能据此确认永久删除。</p> : null}
      {state.remote.status === 'present' && state.membership !== 'not_listed' ? null : <p>Roc 已收录的题录、证据与附件保留。</p>}
      <details><summary className="cursor-pointer">来源状态观察原文</summary>
        <pre className="whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify(state, null, 2)}</pre>
      </details>
    </div>}
    {[stored.error, observe.error].map((error, index) => error === null ? null : <p key={index} role="alert"
      className="flex items-start gap-1 text-[var(--st-warn)]"><AlertTriangle size={14} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 break-words">{error}</span></p>)}
  </section>;
}

export function ZoteroOriginalSource({client, projectId, collectionKey, original, attachments}: Omit<Props, 'original'> & {original: Original | null; attachments: ZoteroAttachmentJobs}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <details className="mt-2 text-muted" data-testid="literature-zotero-previous-source"
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">已收录的原始来源</summary>
    {original === null ? <p>当前范围没有已收录的原始来源。</p> : <>
      <p>来源版本 {original.version}，收录时间 {original.importedAt}</p>
      {open ? <ZoteroSourceStatePanel key={JSON.stringify([projectId, collectionKey, original.scope, original.operationId, original.itemKey, original.version])}
        client={client} projectId={projectId} collectionKey={collectionKey} original={original} /> : null}
      <ZoteroAttachmentPanel key={JSON.stringify([projectId, original.scope, original.operationId, original.itemKey, original.version])}
        client={client} original={original} jobs={attachments} />
      <pre className="whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify(original.item, null, 2)}</pre>
    </>}
  </details>;
}
