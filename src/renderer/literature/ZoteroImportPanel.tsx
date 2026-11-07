import {useEffect, useState} from 'react';
import {AlertTriangle} from 'lucide-react';
import type {ZoteroItem, ZoteroPageRequest, ZoteroPreviewPage, ZoteroScope, ZoteroReview} from '../../shared/schemas/research-zotero';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import type {ZoteroImportJob} from './use-zotero-import-job';
import type {ZoteroSync, ZoteroSyncCapturedPage} from '../../shared/schemas/research-zotero-sync';
import {ZoteroOriginalSource} from './ZoteroSourceStatePanel';
import type {ZoteroAttachmentJobs} from './use-zotero-attachment-jobs';

const buttonClass = `${formSecondaryButtonClass} border-[0.5px]`;
const inputClass = `${formInputClass} border-[0.5px] text-[var(--font-meta-size)]`;
const connectionLabels = {disabled: '未启用通信。请在 Zotero 高级设置中允许其他应用通信。',
  unreachable: 'Zotero 不可达。打开应用后重新连接。',
  unsupported: '版本不支持。需要 Zotero 10 或更新版本。',
  invalid_response: '本地服务响应无效。请检查 Zotero 客户端。'};

export function ZoteroImportPanel({client, job, attachments}: {client: RocClient; job: ZoteroImportJob; attachments: ZoteroAttachmentJobs}): React.JSX.Element {
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
      client={client} serverId={connection.serverId} job={job} attachments={attachments} /> : null}
    <ImportReceipt job={job} />
  </div>;
}

function ConnectedLibraries({client, serverId, job, attachments}: {client: RocClient; serverId: string; job: ZoteroImportJob; attachments: ZoteroAttachmentJobs}): React.JSX.Element {
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
      libraryName={libraryName} job={job} attachments={attachments} />
  </>;
}

function LibraryPreview({client, scope, libraryName, job, attachments}: {
  client: RocClient; scope: ZoteroScope; libraryName: string; job: ZoteroImportJob; attachments: ZoteroAttachmentJobs
}): React.JSX.Element {
  const [query, setQuery] = useState<Pick<ZoteroPageRequest, 'offset' | 'expectedLibraryVersion'>>({offset: 0, expectedLibraryVersion: null});
  const [collection, setCollection] = useState<{key: string; name: string} | null>(null);
  const [limit, setLimit] = useState(20);
  const [snapshot, setSnapshot] = useState<{page: ZoteroPreviewPage; records: ZoteroItem[]; importedKeys: string[]} | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [syncOverride, setSyncOverride] = useState<{value: ZoteroSync | null} | null>(null);
  const [skipReason, setSkipReason] = useState('');
  const lookup = useAsyncResource(`zotero:sync:${JSON.stringify([job.projectId, scope, collection?.key ?? null])}`,
    () => client.api.research.findZoteroSync({...scope, projectId: job.projectId, collectionKey: collection?.key ?? null}),
    {label: '读取同步检查点'});
  const sync = syncOverride === null ? lookup.status === 'ready' ? lookup.data : null : syncOverride.value;
  const ongoing = sync?.status === 'active' || sync?.status === 'paused';
  const begin = useAsyncAction(client.api.research.startZoteroSync, {label: '建立逐页核对'});
  const syncPage = useAsyncAction(client.api.research.captureZoteroSyncPage, {label: '读取核对页'});
  const readPending = useAsyncAction(client.api.research.readZoteroSyncPage, {label: '恢复待核对页'});
  const readState = useAsyncAction(client.api.research.readZoteroSync, {label: '刷新核对状态'});
  const control = useAsyncAction(client.api.research.controlZoteroSync, {label: '控制逐页核对'});
  const acknowledge = useAsyncAction(client.api.research.acknowledgeZoteroSync, {label: '确认本页核对'});
  const collections = useAsyncResource(`zotero:collections:${JSON.stringify([scope, query])}`,
    () => client.api.research.getZoteroCollections({...scope, ...query, limit: 20}), {label: '读取 Zotero 集合'});
  const collectionPage = collections.status === 'ready' ? collections.data : null;
  const capture = useAsyncAction(client.api.research.previewZotero, {label: '预览 Zotero 题录'});
  const readMore = useAsyncAction(client.api.research.getZoteroPreview, {label: '读取已保存的 Zotero 预览'});
  const review = useAsyncResource(snapshot === null || selected.size === 0 ? null :
    `zotero:review:${JSON.stringify([job.projectId, snapshot.page.previewId, [...selected]])}`,
  () => client.api.research.reviewZotero({projectId: job.projectId, previewId: snapshot!.page.previewId, itemKeys: [...selected]}),
  {label: '审查 Zotero 与本地字段'});
  const reviewed = review.status === 'ready' ? review.data : null;
  const blocked = reviewed?.items.some(item => item.local?.archived || !['new', 'unchanged', 'new_version'].includes(item.objectState)) === true;
  const busy = job.pending || job.cancelling || capture.pending || readMore.pending || begin.pending ||
    syncPage.pending || readPending.pending || readState.pending || control.pending || acknowledge.pending;
  const reset = (): void => {
    setSnapshot(null); setSelected(new Set()); setSkipReason('');
    capture.reset(); readMore.reset(); syncPage.reset(); readPending.reset(); acknowledge.reset();
    begin.reset(); control.reset(); readState.reset();
  };
  const acceptPage = (data: ZoteroSyncCapturedPage): void => {
    setSyncOverride({value: data.sync});
    setSnapshot({page: data.preview, records: data.preview.sourcePage.records, importedKeys: data.importedKeys});
    setSelected(new Set()); setSkipReason('');
  };
  const syncId = sync?.syncId;
  const pendingPreviewId = sync?.pendingPreviewId;
  useEffect(() => {
    if (syncId === undefined || pendingPreviewId === null || pendingPreviewId === undefined ||
      job.result === null || ['queued', 'running'].includes(job.result.status) ||
      !job.selection.some(item => item.previewId === pendingPreviewId)) return;
    let active = true;
    void readPending.run({projectId: job.projectId, syncId}).then(result => {
      if (active && result.ok) acceptPage(result.data);
    });
    return () => {active = false;};
  }, [syncId, pendingPreviewId, job.result, job.projectId]);

  async function start(mode: ZoteroSync['mode']): Promise<void> {
    reset();
    const result = await begin.run({...scope, projectId: job.projectId, collectionKey: collection?.key ?? null, mode, limit});
    if (result.ok) setSyncOverride({value: result.data});
  }
  async function controlSync(action: 'pause' | 'resume' | 'abandon'): Promise<void> {
    const result = await control.run({projectId: job.projectId, syncId: sync!.syncId, expectedRevision: sync!.revision, action});
    if (result.ok) {
      setSyncOverride({value: result.data});
      if (action === 'abandon') reset();
    } else await refreshSync();
  }
  async function refreshSync(): Promise<void> {
    const result = await readState.run({projectId: job.projectId, syncId: sync!.syncId});
    if (result.ok) setSyncOverride({value: result.data});
  }
  async function openPending(): Promise<void> {
    reset();
    const result = await readPending.run({projectId: job.projectId, syncId: sync!.syncId});
    if (result.ok) acceptPage(result.data);
  }
  async function confirmPage(): Promise<void> {
    const current = snapshot!;
    const result = await acknowledge.run({projectId: job.projectId, syncId: sync!.syncId, expectedRevision: sync!.revision,
      previewId: current.page.previewId, importedKeys: current.importedKeys,
      skipped: current.records.filter(item => !current.importedKeys.includes(item.key))
        .map(item => ({itemKey: item.key, reason: skipReason.trim()}))});
    if (result.ok) {setSyncOverride({value: result.data}); reset();}
    else await refreshSync();
  }

  async function preview(offset: number): Promise<void> {
    if (sync?.status === 'active') {
      reset();
      const result = await syncPage.run({projectId: job.projectId, syncId: sync.syncId, expectedRevision: sync.revision,
        replacePreviewId: sync.pendingPreviewId});
      if (result.ok) acceptPage(result.data);
      else await refreshSync();
      return;
    }
    const expectedLibraryVersion = snapshot?.page.sourcePage.libraryVersion ?? collectionPage!.libraryVersion;
    reset();
    const result = await capture.run({...scope, projectId: job.projectId, expectedLibraryVersion, collectionKey: collection?.key ?? null,
      since: null, offset, limit});
    if (result.ok) setSnapshot({page: result.data, records: result.data.sourcePage.records, importedKeys: []});
  }
  async function more(): Promise<void> {
    const current = snapshot!;
    const result = await readMore.run({projectId: job.projectId, previewId: current.page.previewId, offset: current.page.nextPreviewOffset!, limit: 20});
    if (result.ok) setSnapshot({...current, page: result.data, records: [...current.records, ...result.data.sourcePage.records]});
  }
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-muted">集合
        <select className={inputClass} value={collection?.key ?? ''} disabled={busy || collectionPage === null}
          data-testid="literature-zotero-collection" onChange={event => {
            setCollection(event.target.value === '' ? null : {key: event.target.value, name: event.target.selectedOptions[0].label});
            setSyncOverride(null); reset();
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
        <select className={inputClass} value={ongoing ? sync.limit : limit} disabled={busy || ongoing} data-testid="literature-zotero-limit"
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
    <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" aria-label="逐页核对" data-testid="literature-zotero-sync">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={busy || ongoing || lookup.status !== 'ready'}
          data-testid="literature-zotero-sync-start" onClick={() => void start('incremental')}>增量逐页核对</button>
        <button type="button" className={buttonClass} disabled={busy || ongoing || lookup.status !== 'ready'}
          data-testid="literature-zotero-sync-full" onClick={() => void start('full')}>完整重新核对</button>
        {sync?.status !== 'reset_required' ? null : <button type="button" className={buttonClass} disabled={busy}
          data-testid="literature-zotero-sync-rebaseline" onClick={() => void start('rebaseline')}>按当前来源重新建立检查点</button>}
        {sync?.status === 'active' ? <button type="button" className={buttonClass} disabled={job.cancelling || control.pending}
          data-testid="literature-zotero-sync-pause" onClick={() => void controlSync('pause')}>暂停核对</button> : null}
        {sync?.status === 'paused' ? <button type="button" className={buttonClass} disabled={busy}
          data-testid="literature-zotero-sync-resume" onClick={() => void controlSync('resume')}>继续核对</button> : null}
        {ongoing ? <button type="button" className={buttonClass} disabled={busy}
          data-testid="literature-zotero-sync-abandon" onClick={() => void controlSync('abandon')}>结束本次核对</button> : null}
        {sync === null ? null : <button type="button" className={buttonClass} disabled={busy}
          data-testid="literature-zotero-sync-refresh" onClick={() => void refreshSync()}>刷新核对状态</button>}
        {sync?.pendingPreviewId === null || sync === null ? null : <button type="button" className={buttonClass} disabled={busy}
          data-testid="literature-zotero-sync-open" onClick={() => void openPending()}>打开待核对页</button>}
      </div>
      {sync === null ? <p className="text-subtle">逐页收录或明确跳过后才推进检查点；中断后可继续。</p> : <p className="break-words text-muted" role="status">
        {sync.status === 'active' ? '核对中' : sync.status === 'paused' ? '已暂停' : sync.status === 'completed' ? '本次核对完成' : '需要重新建立核对'}
        {' · '}已确认 {sync.nextOffset} 个对象，完整版本 {sync.checkpointVersion ?? '尚未建立'}
        {sync.targetVersion === null ? null : `，本次版本 ${sync.targetVersion}`}
        {sync.errorCode === null ? null : ` · ${sync.errorCode}`}
      </p>}
      {sync?.mode === 'rebaseline' ? <p className="text-subtle">本次按当前来源版本重新建立检查点；旧核对历史与本地资料保留。</p> : null}
      {[lookup.error, begin.error, syncPage.error, readPending.error, readState.error, control.error, acknowledge.error]
        .filter((message): message is string => message !== null).map((message, index) => <Failure key={index} message={message} />)}
    </section>
    <div className="flex items-center gap-2">
      <button type="button" className={buttonClass} disabled={busy || collectionPage === null || sync?.status === 'paused'}
        data-testid="literature-zotero-preview" onClick={() => void preview(0)}>
        {capture.pending || syncPage.pending ? '读取中…' : ongoing ? sync.pendingPreviewId === null ? '读取下一页并预览' : '重新读取本页' : '读取并预览'}
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
        {snapshot.records.map(item => <ObjectRow key={`${snapshot.page.previewId}:${item.key}`} item={item} checked={selected.has(item.key)}
          client={client} attachments={attachments} previewId={snapshot.page.previewId} collectionKey={collection?.key ?? null}
          imported={snapshot.importedKeys.includes(item.key)}
          disabled={busy || snapshot.importedKeys.includes(item.key) || (!selected.has(item.key) && selected.size >= 30)}
          onSelect={checked => setSelected(current => {
            const next = new Set(current);
            if (checked) next.add(item.key); else next.delete(item.key);
            return next;
          })} />)}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {snapshot.page.nextPreviewOffset === null ? null : <button type="button" className={buttonClass} disabled={busy}
          data-testid="literature-zotero-more-preview" onClick={() => void more()}>显示本次预览更多对象</button>}
        <button type="button" className={`${formPrimaryButtonClass} border-[0.5px]`} disabled={busy || selected.size === 0 || reviewed === null || blocked}
          data-testid="literature-zotero-import" onClick={() => void job.submit(snapshot.records
            .filter(item => selected.has(item.key)).map(item => ({previewId: snapshot.page.previewId, itemKey: item.key, title: String(item.data.title)}))).then(imported => {if (imported) setSelected(new Set());})}>
          收录选中 {selected.size} 篇
        </button>
        <button type="button" className={buttonClass} disabled={busy || selected.size === 0}
          onClick={() => setSelected(new Set())}>取消选择</button>
        <button type="button" className={buttonClass}
          disabled={busy || ongoing || snapshot.page.sourcePage.nextOffset === null || selected.size > 0}
          data-testid="literature-zotero-next-source" onClick={() => void preview(snapshot.page.sourcePage.nextOffset!)}>下一页来源</button>
      </div>
      {selected.size > 0 && reviewed === null && review.error === null ? <p role="status" className="text-muted">正在核对选中题录与本地字段…</p> : null}
      {review.error === null ? null : <Failure message={review.error} />}
      {reviewed === null ? null : <SourceReview review={reviewed} client={client} projectId={job.projectId} collectionKey={collection?.key ?? null} attachments={attachments} />}
      {sync?.status !== 'active' || sync.pendingPreviewId !== snapshot.page.previewId ? null : <div className="flex flex-col gap-2">
        <p className="text-muted">本页已收录 {snapshot.importedKeys.length} 个，确认时跳过 {snapshot.page.capturedTotal - snapshot.importedKeys.length} 个。</p>
        {snapshot.page.capturedTotal === snapshot.importedKeys.length ? null : <label className="flex flex-col gap-1 text-muted">
          未收录对象的跳过理由
          <input className={inputClass} value={skipReason} maxLength={500} disabled={busy}
            data-testid="literature-zotero-sync-skip-reason" onChange={event => setSkipReason(event.target.value)} />
        </label>}
        <button type="button" className={`${formPrimaryButtonClass} border-[0.5px]`}
          data-testid="literature-zotero-sync-confirm" disabled={busy || selected.size > 0 ||
            snapshot.records.length !== snapshot.page.capturedTotal ||
            (snapshot.page.capturedTotal !== snapshot.importedKeys.length && skipReason.trim() === '')}
          onClick={() => void confirmPage()}>确认本页核对</button>
        {snapshot.records.length !== snapshot.page.capturedTotal ? <p className="text-subtle">先显示本次预览全部对象，再确认本页。</p> : null}
      </div>}
      <p className="text-subtle">每次最多收录 30 篇。翻页前先收录或取消本页选择；附件需另行授权。</p>
    </>}
  </div>;
}

function ObjectRow({item, checked, disabled, imported, onSelect, client, attachments, previewId, collectionKey}: {
  item: ZoteroItem; checked: boolean; disabled: boolean; imported: boolean; onSelect: (checked: boolean) => void;
  client: RocClient; attachments: ZoteroAttachmentJobs; previewId: string; collectionKey: string | null
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
      {imported ? <span>本页已收录</span> : null}
    </div>
    <details className="mt-1 pl-5" data-testid="literature-zotero-object-details">
      <summary className="cursor-pointer text-muted">题录、标签、集合与附件引用</summary>
      <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)] text-muted">{JSON.stringify(item, null, 2)}</pre>
    </details>
    {imported ? <ImportedSource client={client} attachments={attachments} previewId={previewId} itemKey={item.key} collectionKey={collectionKey} /> : null}
  </li>;
}

function ImportedSource({client, attachments, previewId, itemKey, collectionKey}: {
  client: RocClient; attachments: ZoteroAttachmentJobs; previewId: string; itemKey: string; collectionKey: string | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const input = {projectId: attachments.projectId, previewId, itemKeys: [itemKey]};
  const review = useAsyncResource(open ? `zotero:imported-review:${JSON.stringify(input)}` : null,
    () => client.api.research.reviewZotero(input), {label: '查看已收录来源'});
  return <details className="mt-2 pl-5" data-testid="literature-zotero-imported-source"
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-ink">查看已收录来源与附件</summary>
    {review.status === 'loading' ? <p role="status">正在读取已收录来源…</p> : null}
    {review.error === null ? null : <Failure message={review.error} />}
    {review.status !== 'ready' || review.data === null ? null : <SourceReview review={review.data} client={client}
      projectId={attachments.projectId} collectionKey={collectionKey} attachments={attachments} />}
  </details>;
}

function SourceReview({review, client, projectId, collectionKey, attachments}: {
  review: ZoteroReview; client: RocClient; projectId: string | null; collectionKey: string | null; attachments: ZoteroAttachmentJobs
}): React.JSX.Element {
  const states: Record<ZoteroReview['items'][number]['objectState'], string> = {
    new: '新来源对象', unchanged: '来源版本未变化', new_version: '新来源版本',
    version_regressed: '来源版本回退，不能收录', version_conflict: '同版本内容不同，不能收录',
    identity_changed: '来源对象的文献身份改变，不能收录'
  };
  const fields = {title: '题名', authors: '作者', doi: 'DOI', abstract: '摘要', url: 'URL'};
  const value = (input: unknown): string => typeof input === 'string' ? input : JSON.stringify(input);
  return <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" aria-label="来源与本地字段" data-testid="literature-zotero-source-review">
    <p className="text-muted">题名、已有作者与本地注释保留；缺失字段可补齐，原始来源另存。</p>
    <div className="max-h-60 overflow-y-auto px-1" tabIndex={0} aria-label="选中来源差异">
      {review.items.map(item => <details key={item.source.item.key} className="border-b-[0.5px] border-line py-2"
        data-testid="literature-zotero-reviewed-object" data-item-key={item.source.item.key}>
        <summary className="cursor-pointer break-words text-ink">
          {item.source.metadata.title}{' '}
          <span className="ml-2 text-muted">{states[item.objectState]}</span>{' '}
          {item.mappedVersion === null ? null : <><span className="ml-2 text-subtle">已记录对象版本 {item.mappedVersion}</span>{' '}</>}
          {item.local === null ? null : <><span className="ml-2 text-subtle">本地版本 {item.local.revision}</span>{' '}</>}
          {item.local?.archived ? <><span className="ml-2 text-muted">已归档，不能收录</span>{' '}</> : null}
          <span className="ml-2 text-subtle">{item.differences.length} 个字段不同</span>
        </summary>
        <CitationKeyMapping mapping={item.citationKeyMapping} preview />
        {item.local?.archived ? <p className="mt-1 text-muted">本地文献已归档，恢复后才能收录。</p> : null}
        {item.differences.length === 0 ? null : <table className="mt-2 w-full table-fixed text-left">
          <caption className="sr-only">Zotero 来源原值与 Roc 本地现值</caption>
          <thead className="text-subtle"><tr><th className="w-14 font-normal">字段</th><th className="font-normal">Zotero</th><th className="font-normal">Roc</th></tr></thead>
          <tbody>{item.differences.map(difference => <tr key={difference.field} className="border-t-[0.5px] border-line align-top">
            <th className="py-1 font-normal text-muted">{fields[difference.field]}</th>
            <td className="whitespace-pre-wrap break-all px-1 py-1 text-muted">{value(difference.source)}</td>
            <td className="whitespace-pre-wrap break-all px-1 py-1 text-muted">{value(difference.local)}</td>
          </tr>)}</tbody>
        </table>}
        {item.local === null ? null : <details className="mt-2 text-muted" data-testid="literature-zotero-local-fields">
          <summary className="cursor-pointer">本地书目字段</summary>
          <pre className="whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(item.local.bibliography.fields, null, 2)}</pre>
        </details>}
        <ZoteroOriginalSource client={client} projectId={projectId} collectionKey={collectionKey} original={item.previousScopedSource} attachments={attachments} />
      </details>)}
    </div>
  </section>;
}

function CitationKeyMapping({mapping, preview = false}: {
  mapping: ZoteroReview['items'][number]['citationKeyMapping']; preview?: boolean
}): React.JSX.Element {
  const issues = {invalid_source_key: '来源键格式无效', source_disagreement: '多个来源键不一致',
    key_collision: '来源键已被其他文献占用', local_key_retained: '保留已使用的本地键'};
  return <p className="mt-1 break-all text-muted" data-testid="literature-zotero-citation-key-mapping">
    来源引文键：{mapping.candidates.map(candidate => `${candidate.origin}: ${candidate.value}`).join('；') || '未提供'}；
    {preview ? '预计本地键' : '本地键'}：{mapping.localKey ?? '收录时生成'}。
    {mapping.issues.map(issue => issues[issue]).join('；')}
    {preview ? '收录时会重新检查重名，以回执为准。' : null}
  </p>;
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
          {item.citationKeyMapping === undefined ? null : <CitationKeyMapping mapping={item.citationKeyMapping} />}
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
