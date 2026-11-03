import {useState} from 'react';
import type {ZoteroReview, ZoteroItem} from '../../shared/schemas/research-zotero';
import type {ZoteroChildrenPage} from '../../shared/schemas/research-zotero-attachment';
import {useAsyncAction} from '../app/use-async-resource';
import {formPrimaryButtonClass, formSecondaryButtonClass, formInputClass} from '../shared/form-ui';
import type {RocClient} from '../shared/roc-client';
import type {ZoteroAttachmentJobs, ZoteroAttachmentSource} from './use-zotero-attachment-jobs';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
type Original = NonNullable<ZoteroReview['items'][number]['previousScopedSource']>;

export function ZoteroAttachmentPanel({client, original, jobs}: {
  client: RocClient; original: Original; jobs: ZoteroAttachmentJobs
}): React.JSX.Element {
  const [page, setPage] = useState<ZoteroChildrenPage | null>(null);
  const read = useAsyncAction(client.api.research.getZoteroChildren, {label: '读取当前子项'});
  async function discover(offset: number): Promise<void> {
    const version = offset === 0 ? null : page!.page.libraryVersion;
    setPage(null);
    const response = await read.run({...original.scope, projectId: jobs.projectId,
      operationId: original.operationId, itemKey: original.itemKey, offset, limit: 20, expectedLibraryVersion: version});
    if (response.ok) setPage(response.data);
  }
  return <details className="mt-2" data-testid="literature-zotero-attachments">
    <summary className="cursor-pointer text-ink">附件与当前子项</summary>
    <div className="mt-2 flex flex-col gap-2">
      <button type="button" className={`${button} self-start`} disabled={read.pending}
        data-testid="literature-zotero-children-read" onClick={() => void discover(0)}>
        {read.pending ? '读取中…' : '读取当前子项'}
      </button>
      {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
      {page === null ? null : <>
        <p role="status">子项 {page.page.offset + (page.page.records.length > 0 ? 1 : 0)}–{page.page.offset + page.page.records.length} / {page.page.total}，
          文库版本 {page.page.libraryVersion}</p>
        <ul aria-label="Zotero 当前子项">
          {page.page.records.map(item => <li key={item.key} className="border-b-[0.5px] border-line py-2"
            data-testid="literature-zotero-child" data-item-key={item.key}>
            <p className="break-words text-ink">{typeof item.data.title === 'string' ? item.data.title : item.key}</p>
            <p className="flex flex-wrap gap-x-3 text-muted"><span>{item.data.itemType}</span><span>对象 {item.key}</span><span>版本 {item.version}</span></p>
            {item.data.itemType !== 'attachment' ? <p>笔记或批注，不作为附件导入。</p> :
              <Attachment item={item} jobs={jobs} source={{...original.scope, operationId: original.operationId,
                itemKey: original.itemKey, attachmentKey: item.key}} />}
            <details><summary className="cursor-pointer">子项原文</summary>
              <pre className="whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(item, null, 2)}</pre>
            </details>
          </li>)}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={read.pending || page.page.offset === 0}
            onClick={() => void discover(Math.max(0, page.page.offset - 20))}>上一页子项</button>
          <button type="button" className={button} disabled={read.pending || page.page.nextOffset === null}
            data-testid="literature-zotero-children-next" onClick={() => void discover(page.page.nextOffset!)}>下一页子项</button>
        </div>
      </>}
    </div>
  </details>;
}

function Attachment({item, jobs, source}: {item: ZoteroItem; jobs: ZoteroAttachmentJobs; source: ZoteroAttachmentSource}): React.JSX.Element {
  const state = jobs.get(source);
  const [destination, setDestination] = useState<'library_only' | 'current_project'>(jobs.projectId === null ? 'library_only' : 'current_project');
  const busy = state.phase !== 'idle' || state.cancelling;
  const file = state.inspection?.file;
  const modes = {imported_file: 'Zotero 管理文件', imported_url: 'Zotero 保存的网页文件',
    linked_file: '链接文件', linked_url: '链接网址', embedded_image: '嵌入图片'};
  const statuses = {ready: '文件可访问，尚需选择授权', missing: '文件缺失或断链', denied: '无权读取文件',
    invalid: '路径或文件类型无效', unsupported_format: '文件格式或大小不支持'};
  const reasons = {source_not_found: '附件来源未找到', trashed: '附件在回收站',
    linked_url: '链接网址，没有本地文件输入', embedded_image: '嵌入图片不作为文档输入'};
  const documentStates = {imported: '已导入，尚未解析', parsing: '解析中', ready: '解析完成',
    failed: '解析失败', cancelled: '解析已取消'};
  return <div className="my-2 flex flex-col gap-2" data-testid="literature-zotero-attachment">
    <p>{state.inspection?.linkMode === null || state.inspection?.linkMode === undefined ?
      typeof item.data.linkMode === 'string' ? item.data.linkMode : '尚未检查类型' : modes[state.inspection.linkMode]}</p>
    <button type="button" className={`${button} self-start`} disabled={busy}
      data-testid="literature-zotero-attachment-check" onClick={() => void jobs.inspect(source)}>
      {state.phase === 'checking' ? '检查中…' : '检查附件引用'}
    </button>
    {file === undefined ? null : <div role="status" className="flex flex-col gap-1">
      <p>{file.status === 'not_requested' ? reasons[file.reason] :
        file.status === 'ready' && state.grant !== null ? '文件可访问' : statuses[file.status]}</p>
      {file.status === 'not_requested' ? null : <>
        <p className="break-all">来源路径 {file.referencePath}</p>
        {file.resolvedPath === null ? null : <p className="break-all">真实路径 {file.resolvedPath}</p>}
      </>}
      <p>检查时间 <time dateTime={state.inspection!.remote.checkedAt}>{state.inspection!.remote.checkedAt}</time></p>
    </div>}
    {file?.status !== 'ready' || state.grant !== null ? null : <>
      <p>选择上述真实文件，授权 Roc 读取该单个文件。</p>
      <button type="button" className={`${button} self-start`} disabled={busy}
        data-testid="literature-zotero-attachment-grant" onClick={() => void jobs.grant(source)}>
        {state.phase === 'granting' ? '等待文件选择…' : '选择文件并授权读取'}
      </button>
    </>}
    {state.grantCancelled ? <p role="status">已取消文件选择，未授权读取。</p> : null}
    {state.grant === null ? null : <div className="flex flex-col gap-2">
      <p className="break-all" role="status">已授权读取一个文件：{state.grant.selectedPath}</p>
      {state.receipt === null ? <>
        <label className="flex flex-col gap-1">导入范围
          <select className={`${formInputClass} border-[0.5px]`} value={state.importRequest?.destination ?? destination}
            disabled={busy || state.importRequest !== null} data-testid="literature-zotero-attachment-destination"
            onChange={event => setDestination(event.target.value as typeof destination)}>
            <option value="library_only">仅文库</option>
            {jobs.projectId === null ? null : <option value="current_project">文库与当前项目</option>}
          </select>
        </label>
        <button type="button" className={`${formPrimaryButtonClass} self-start border-[0.5px]`} disabled={busy}
          data-testid="literature-zotero-attachment-import" onClick={() => void jobs.importFile(source, destination)}>
          {state.phase === 'importing' ? '导入中…' : state.importRequest === null ? '导入已授权文件' : '重试本次导入'}
        </button>
      </> : <div role="status" data-testid="literature-zotero-attachment-receipt">
        <p>已导入 {state.receipt.document.filename}</p>
        <p>{state.receipt.destinationProjectId === null ? '仅文库' : '文库与当前项目'}，{documentStates[state.receipt.document.status]}</p>
        <p className="break-all">内容 SHA-256 {state.receipt.document.sourceHash}</p>
        <details><summary className="cursor-pointer">附件导入回执</summary>
          <pre className="whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(state.receipt, null, 2)}</pre>
        </details>
      </div>}
    </div>}
    {state.phase !== 'importing' ? null : <button type="button" className={`${button} self-start`}
      disabled={state.cancelling || state.cancelRequested} data-testid="literature-zotero-attachment-cancel" onClick={() => void jobs.cancel(source)}>
      {state.cancelRequested ? '已请求取消，等待导入退出' : state.cancelling ? '请求取消中…' : '取消附件导入'}
    </button>}
    {[state.error, state.cancelError].map((error, i) => error === null ? null :
      <p key={i} role="alert" className="break-words text-[var(--st-warn)]">{error}</p>)}
  </div>;
}
