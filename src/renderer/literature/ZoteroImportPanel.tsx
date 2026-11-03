import {useState} from 'react';
import {AlertTriangle} from 'lucide-react';
import type {ZoteroItem, ZoteroPageRequest, ZoteroPreviewPage, ZoteroScope} from '../../shared/schemas/research-zotero';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import type {ZoteroImportJob} from './use-zotero-import-job';

const buttonClass = `${formSecondaryButtonClass} border-[0.5px]`;
const inputClass = `${formInputClass} border-[0.5px] text-[var(--font-meta-size)]`;
const connectionLabels = {disabled: '未启用通信。请在 Zotero 高级设置中允许其他应用通信。',
  unreachable: 'Zotero 不可达。打开应用后重新连接。',
  unsupported: '版本不支持。需要 Zotero 10 或更新版本。',
  invalid_response: '本地服务响应无效。请检查 Zotero 客户端。'};

export function ZoteroImportPanel({client, job}: {client: RocClient; job: ZoteroImportJob}): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const probe = useAsyncResource(attempt === 0 ? null : `zotero:probe:${attempt}`,
    () => client.api.research.probeZotero({}), {label: '连接 Zotero'});
  const connection = probe.status === 'ready' ? probe.data : null;
  return <div className="flex flex-col gap-3 text-[var(--font-meta-size)]" data-testid="literature-import-panel-zotero">
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{connection?.status === 'connected' ? 'Zotero 已连接' : 'Zotero 本地文库'}</span>
      <button type="button" className={buttonClass} disabled={probe.status === 'loading' || job.pending || job.cancelling}
        data-testid="literature-zotero-connect" onClick={() => setAttempt(current => current + 1)}>
        {probe.status === 'loading' ? '连接中…' : '连接 Zotero'}
      </button>
    </div>
    {probe.error === null ? null : <Failure message={probe.error} />}
    {connection === null || connection.status === 'connected' ? null : <Failure message={connectionLabels[connection.status]} />}
    {connection?.status === 'connected' ? <ConnectedLibraries key={`${attempt}:${connection.serverId}`}
      client={client} serverId={connection.serverId} job={job} /> : null}
    <ImportReceipt job={job} />
  </div>;
}

function ConnectedLibraries({client, serverId, job}: {client: RocClient; serverId: string; job: ZoteroImportJob}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const [library, setLibrary] = useState<ZoteroScope['library']>({kind: 'user', id: 0});
  const [libraryName, setLibraryName] = useState('我的文库');
  const groups = useAsyncResource(`zotero:groups:${serverId}:${offset}`,
    () => client.api.research.getZoteroGroups({serverId, offset, limit: 20}), {label: '读取 Zotero 群组'});
  const page = groups.status === 'ready' ? groups.data : null;
  return <>
    <fieldset className="flex flex-col gap-2" disabled={job.pending || job.cancelling}>
      <legend className="mb-1 text-muted">文库</legend>
      <div className="flex max-h-28 flex-wrap gap-x-4 gap-y-2 overflow-y-auto p-1">
        <label className="flex items-center gap-1.5"><input type="radio" name="zotero-library"
          checked={library.kind === 'user'} onChange={() => {setLibrary({kind: 'user', id: 0}); setLibraryName('我的文库');}}
          data-testid="literature-zotero-library-personal" />我的文库</label>
        {page?.records.map(group => <label key={group.id} className="flex min-w-0 items-center gap-1.5">
          <input type="radio" name="zotero-library" checked={library.kind === 'group' && library.id === group.id}
            onChange={() => {setLibrary({kind: 'group', id: group.id}); setLibraryName(group.data.name);}}
            data-testid={`literature-zotero-library-group-${group.id}`} />
          <span className="break-all">{group.data.name}</span>
        </label>)}
      </div>
      {page === null ? null : <div className="flex flex-wrap items-center gap-2 text-subtle">
        <span>群组 {page.offset + (page.records.length > 0 ? 1 : 0)}–{page.offset + page.records.length} / {page.total}</span>
        <button type="button" className={buttonClass} disabled={offset === 0} onClick={() => setOffset(offset - 20)}>上一页群组</button>
        <button type="button" className={buttonClass} disabled={page.nextOffset === null}
          onClick={() => setOffset(page.nextOffset!)}>下一页群组</button>
      </div>}
    </fieldset>
    {groups.error === null ? null : <Failure message={groups.error} />}
    <LibraryPreview key={`${library.kind}:${library.id}`} client={client} scope={{serverId, library}}
      libraryName={libraryName} job={job} />
  </>;
}

function LibraryPreview({client, scope, libraryName, job}: {
  client: RocClient; scope: ZoteroScope; libraryName: string; job: ZoteroImportJob
}): React.JSX.Element {
  const [query, setQuery] = useState<Pick<ZoteroPageRequest, 'offset' | 'expectedLibraryVersion'>>({offset: 0, expectedLibraryVersion: null});
  const [collection, setCollection] = useState<{key: string; name: string} | null>(null);
  const [limit, setLimit] = useState(20);
  const [snapshot, setSnapshot] = useState<{page: ZoteroPreviewPage; records: ZoteroItem[]} | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const collections = useAsyncResource(`zotero:collections:${JSON.stringify([scope, query])}`,
    () => client.api.research.getZoteroCollections({...scope, ...query, limit: 20}), {label: '读取 Zotero 集合'});
  const collectionPage = collections.status === 'ready' ? collections.data : null;
  const capture = useAsyncAction(client.api.research.previewZotero, {label: '预览 Zotero 题录'});
  const readMore = useAsyncAction(client.api.research.getZoteroPreview, {label: '读取已保存的 Zotero 预览'});
  const busy = job.pending || job.cancelling || capture.pending || readMore.pending;
  const reset = (): void => {setSnapshot(null); setSelected(new Set()); capture.reset(); readMore.reset();};

  async function preview(offset: number): Promise<void> {
    const expectedLibraryVersion = snapshot?.page.sourcePage.libraryVersion ?? collectionPage!.libraryVersion;
    reset();
    const result = await capture.run({...scope, projectId: job.projectId, expectedLibraryVersion, collectionKey: collection?.key ?? null,
      since: null, offset, limit});
    if (result.ok) setSnapshot({page: result.data, records: result.data.sourcePage.records});
  }
  async function more(): Promise<void> {
    const current = snapshot!;
    const result = await readMore.run({projectId: job.projectId, previewId: current.page.previewId, offset: current.page.nextPreviewOffset!, limit: 20});
    if (result.ok) setSnapshot({page: result.data, records: [...current.records, ...result.data.sourcePage.records]});
  }
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-muted">集合
        <select className={inputClass} value={collection?.key ?? ''} disabled={busy || collectionPage === null}
          data-testid="literature-zotero-collection" onChange={event => {
            setCollection(event.target.value === '' ? null : {key: event.target.value, name: event.target.selectedOptions[0].label});
            reset();
          }}>
          <option value="">整个文库</option>
          {collection !== null && !collectionPage?.records.some(item => item.key === collection.key) ?
            <option value={collection.key}>{collection.name}</option> : null}
          {collectionPage?.records.map(item => <option key={item.key} value={item.key}>
            {item.data.name}{item.data.parentCollection === false ? '' : `（父集合 ${item.data.parentCollection}）`}
          </option>)}
        </select>
      </label>
      <label className="flex w-32 flex-col gap-1 text-muted">每次读取
        <select className={inputClass} value={limit} disabled={busy} data-testid="literature-zotero-limit"
          onChange={event => {setLimit(Number(event.target.value)); reset();}}>
          {[20, 30, 50].map(value => <option key={value} value={value}>{value} 个对象</option>)}
        </select>
      </label>
    </div>
    {collectionPage === null ? null : <div className="flex flex-wrap items-center gap-2 text-subtle">
      <span>集合 {collectionPage.offset + (collectionPage.records.length > 0 ? 1 : 0)}–{collectionPage.offset + collectionPage.records.length} / {collectionPage.total}</span>
      <button type="button" className={buttonClass} disabled={busy || query.offset === 0}
        onClick={() => setQuery({offset: query.offset - 20, expectedLibraryVersion: collectionPage.libraryVersion})}>上一页集合</button>
      <button type="button" className={buttonClass} disabled={busy || collectionPage.nextOffset === null}
        onClick={() => setQuery({offset: collectionPage.nextOffset!, expectedLibraryVersion: collectionPage.libraryVersion})}>下一页集合</button>
    </div>}
    {collections.error === null ? null : <Failure message={collections.error} />}
    <div className="flex items-center gap-2">
      <button type="button" className={buttonClass} disabled={busy || collectionPage === null}
        data-testid="literature-zotero-preview" onClick={() => void preview(0)}>
        {capture.pending ? '读取中…' : '读取并预览'}
      </button>
      <span className="min-w-0 break-all text-muted">{libraryName}{collection === null ? '' : ` / ${collection.name}`}</span>
    </div>
    {capture.error === null ? null : <Failure message={capture.error} />}
    {readMore.error === null ? null : <Failure message={readMore.error} />}
    {snapshot === null ? null : <>
      <p role="status" className="text-muted" data-testid="literature-zotero-page-summary">
        来源 {snapshot.page.sourcePage.offset + (snapshot.page.capturedTotal > 0 ? 1 : 0)}–{snapshot.page.sourcePage.offset + snapshot.page.capturedTotal} / {snapshot.page.sourcePage.total} 个对象。
        已显示 {snapshot.records.length} / {snapshot.page.capturedTotal} 个。
      </p>
      <ul className="max-h-64 overflow-y-auto px-1" tabIndex={0} aria-label="Zotero 预览对象">
        {snapshot.records.map(item => <ObjectRow key={item.key} item={item} checked={selected.has(item.key)}
          disabled={busy || (!selected.has(item.key) && selected.size >= 30)}
          onSelect={checked => setSelected(current => {
            const next = new Set(current);
            if (checked) next.add(item.key); else next.delete(item.key);
            return next;
          })} />)}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {snapshot.page.nextPreviewOffset === null ? null : <button type="button" className={buttonClass} disabled={busy}
          data-testid="literature-zotero-more-preview" onClick={() => void more()}>显示本次预览更多对象</button>}
        <button type="button" className={`${formPrimaryButtonClass} border-[0.5px]`} disabled={busy || selected.size === 0}
          data-testid="literature-zotero-import" onClick={() => void job.submit(snapshot.records
            .filter(item => selected.has(item.key)).map(item => ({previewId: snapshot.page.previewId, itemKey: item.key, title: String(item.data.title)}))).then(imported => {if (imported) setSelected(new Set());})}>
          收录选中 {selected.size} 篇
        </button>
        <button type="button" className={buttonClass} disabled={busy || selected.size === 0}
          onClick={() => setSelected(new Set())}>取消选择</button>
        <button type="button" className={buttonClass}
          disabled={busy || snapshot.page.sourcePage.nextOffset === null || selected.size > 0}
          data-testid="literature-zotero-next-source" onClick={() => void preview(snapshot.page.sourcePage.nextOffset!)}>下一页来源</button>
      </div>
      <p className="text-subtle">每次最多收录 30 篇。翻页前先收录或取消本页选择；附件需另行授权。</p>
    </>}
  </div>;
}

function ObjectRow({item, checked, disabled, onSelect}: {
  item: ZoteroItem; checked: boolean; disabled: boolean; onSelect: (checked: boolean) => void
}): React.JSX.Element {
  const title = typeof item.data.title === 'string' ? item.data.title.trim() : '';
  const paper = !['attachment', 'note', 'annotation'].includes(item.data.itemType);
  const selectable = paper && title !== '' && typeof item.csljson === 'string' && item.csljson.trim() !== '';
  const reason = !paper ? item.data.itemType === 'attachment' ? '附件引用，尚未授权' : '笔记或批注，不作为论文收录' :
    !selectable ? '题录或 CSL 缺失，不能收录' : null;
  return <li className="border-b-[0.5px] border-line py-2" data-testid="literature-zotero-object" data-item-key={item.key}>
    <label className="flex items-start gap-2">
      <input type="checkbox" checked={checked} disabled={disabled || !selectable}
        onChange={event => onSelect(event.target.checked)} className="mt-1 shrink-0"
        aria-label={`选择 ${title || item.key}`} />
      <span className="min-w-0 break-words text-[var(--font-body-size)] text-ink">{title || '题名未提供'}</span>
    </label>
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-5 text-subtle">
      <span>{item.data.itemType}</span><span>对象 {item.key}</span><span>版本 {item.version}</span>
      {reason === null ? null : <span>{reason}</span>}
    </div>
    <details className="mt-1 pl-5" data-testid="literature-zotero-object-details">
      <summary className="cursor-pointer text-muted">题录、标签、集合与附件引用</summary>
      <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)] text-muted">{JSON.stringify(item, null, 2)}</pre>
    </details>
  </li>;
}

function ImportReceipt({job}: {job: ZoteroImportJob}): React.JSX.Element | null {
  const labels = {created: '已收录', linked: '已关联项目', already_present: '已存在',
    skipped_archived: '已归档，未恢复', failed: '失败', cancelled: '已取消', not_processed: '未处理'};
  return <>
    {job.pending ? <div className="flex flex-wrap items-center gap-2" role="status" data-testid="literature-zotero-import-running">
      <span>收录中 {job.selection.length} 篇</span>
      <button type="button" className={buttonClass} disabled={job.cancelling || job.cancelRequested}
        data-testid="literature-zotero-cancel-import" onClick={() => void job.requestCancel()}>
        {job.cancelRequested ? '已请求取消' : job.cancelling ? '请求取消中…' : '取消收录'}
      </button>
      <span className="text-subtle">关闭弹窗后作业继续；重新打开 Zotero 可查看结果。</span>
    </div> : null}
    {job.error === null ? null : <Failure message={job.error} />}
    {job.cancelError === null ? null : <Failure message={job.cancelError} />}
    {job.result === null ? null : <div className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2"
      data-testid="literature-zotero-import-result" role="status">
      <p className="text-muted">已收录 {job.result.counts.created}，已关联 {job.result.counts.linked}，
        已存在 {job.result.counts.alreadyPresent}，失败 {job.result.counts.failed}，取消 {job.result.counts.cancelled}，
        归档跳过 {job.result.counts.skippedArchived}。</p>
      <ul className="max-h-36 overflow-y-auto px-1" aria-label="Zotero 收录结果" tabIndex={0}>
        {job.result.items.map(item => <li key={item.entryKey} className="border-b-[0.5px] border-line py-1">
          <span className="break-words text-ink">{job.selection[item.inputPositions[0]].title}</span>
          <span className="ml-2 text-muted">{labels[item.disposition]}</span>
          {item.errorCode === null ? null : <span className="ml-2 break-all font-mono text-muted">{item.errorCode}</span>}
        </li>)}
      </ul>
      {job.result.items.some(item => item.retryable) ? <button type="button" className={buttonClass} disabled={job.pending || job.cancelling}
        data-testid="literature-zotero-retry" onClick={() => void job.submit(job.result!.items
          .filter(item => item.retryable).map(item => job.selection[item.inputPositions[0]]))}>重试可重试条目</button> : null}
    </div>}
  </>;
}

function Failure({message}: {message: string}): React.JSX.Element {
  return <p role="alert" className="flex items-start gap-1 text-[var(--font-meta-size)] text-[var(--st-warn)]">
    <AlertTriangle size={14} aria-hidden="true" className="shrink-0" /><span className="min-w-0 break-words">{message}</span>
  </p>;
}
