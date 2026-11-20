import {useEffect, useRef, useState} from 'react';
import {ChevronDown, ChevronRight, RefreshCw} from 'lucide-react';
import {PipelineProgress} from './PipelineProgress';
import {literaturePipeline} from './pipeline-state';
import {AcquisitionPreferences} from './AcquisitionPreferences';
import type {PaperAcquisitionJob} from '../../shared/schemas/literature-acquisition';
import {useAsyncResource} from '../app/use-async-resource';
import {runIpcAction} from '../app/loaded-state';
import {useVisiblePolling} from '../shared/view-activity';
import type {RocClient} from '../shared/roc-client';
import type {LiteratureImportOutcome} from './use-literature-store';
import {acquisitionPageProgress, acquisitionStageLabels, acquisitionStatusLabels, canCancelAcquisition,
  canRetryAcquisition, changeLiteratureProcessing, listLiteratureProcessing} from './literature-processing';

type Props = {
  client: RocClient; projectId: string; writable: boolean;
  pickFile: () => Promise<string | null>;
  addPdfToItem: (input: {sourcePath: string; libraryItemId: string}) => Promise<LiteratureImportOutcome>;
  onOpenPdf: (relativePath: string) => void;
  onOpenItem: (libraryItemId: string) => void;
  onDocumentsChanged: () => void;
};
const buttonClass = 'min-h-7 rounded-control px-2 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:opacity-50';

/** Mounted once in the existing project canvas, never duplicated in the sidebar. */
export function LiteratureProcessingPanel(props: Props): React.JSX.Element {
  // Key the session so outstanding dialogs and writes cannot continue in another project.
  return <ProcessingSession key={props.projectId} {...props}/>;
}

function ProcessingSession({client, projectId, writable, pickFile, addPdfToItem, onOpenPdf, onOpenItem, onDocumentsChanged}: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false), mounted = useRef(false);
  const writableRef = useRef(writable); writableRef.current = writable;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const page = useAsyncResource(JSON.stringify(['literature-processing', projectId, offset]),
    () => listLiteratureProcessing(client, projectId, offset), {label: '读取文献处理进度'});
  const reload = page.reload;
  // Discovery also runs while the page is empty: an Agent may enqueue new jobs elsewhere.
  useVisiblePolling(reload, 4_000, page.status !== 'loading' && page.error === null);
  useEffect(() => {
    const unsubscribe = client.api.research.onLibraryChanged(event => {
      if (event.affectedProjectIds.includes(projectId)) reload();
    });
    return unsubscribe;
  }, [client, projectId, reload]);
  const jobs = page.data?.jobs ?? [];
  const progress = acquisitionPageProgress(jobs);
  const lastDocuments = useRef('');
  useEffect(() => {
    if (page.data === null) return;
    const revision = JSON.stringify(page.data.jobs.map(job => [job.id, job.documentId, job.stage, job.status]));
    if (lastDocuments.current === revision) return;
    lastDocuments.current = revision;
    if (page.data.jobs.some(job => job.documentId !== null)) onDocumentsChanged();
  }, [page.data, onDocumentsChanged]);

  async function act(job: PaperAcquisitionJob, action: 'retry' | 'cancel' | 'attach'): Promise<void> {
    if (locked.current || !mounted.current || !writableRef.current || job.projectId !== projectId) return;
    locked.current = true; setPending(job.id); setActionError(null); setNotice(null);
    try {
      const result = await runIpcAction<PaperAcquisitionJob | null>(async () => {
        if (action !== 'attach') return changeLiteratureProcessing(client, projectId, job, action);
        const sourcePath = await pickFile();
        if (sourcePath === null || !mounted.current || !writableRef.current) return {ok: true as const, data: null};
        if (!/\.pdf$/i.test(sourcePath)) return {ok: false as const, error: {message: '请选择 PDF 文件。'}};
        const imported = await addPdfToItem({sourcePath, libraryItemId: job.libraryItemId});
        if (!imported.ok) return {ok: false as const, error: {message: imported.message}};
        if (!mounted.current || !writableRef.current) return {ok: true as const, data: null};
        onDocumentsChanged();
        if (!imported.documentId) return {ok: false as const, error: {message: 'PDF 已补充，但未返回文档 ID，未提交后台重试。'}};
        return changeLiteratureProcessing(client, projectId, job, 'retry', imported.documentId);
      });
      if (!mounted.current) return;
      if (!result.ok) setActionError(result.error);
      else if (result.data !== null) {
        setNotice(action === 'attach' ? 'PDF 已补充，已提交后台重试，请查看最新进度。' : action === 'retry' ? '已提交后台重试，请查看最新进度。' :
          `取消请求已处理，当前状态：${acquisitionStatusLabels[result.data.status]}。已生成的文件保留。`);
      }
      reload();
    } finally {
      locked.current = false;
      if (mounted.current) setPending(null);
    }
  }

  return <section aria-label="文献后台处理" data-testid="literature-processing" className="shrink-0 border-b-[0.5px] border-line text-[length:var(--font-meta-size)]">
    <div className="flex flex-wrap items-center gap-2 px-3 py-1">
      <button type="button" className={`${buttonClass} flex items-center gap-1`} aria-expanded={expanded} aria-controls="literature-processing-details"
        onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronDown size={14} aria-hidden="true"/> : <ChevronRight size={14} aria-hidden="true"/>}文献处理
      </button>
      <span role="status" aria-atomic="true" className="min-w-0 flex-1 text-muted tabular-nums">
        {page.data === null ? page.status === 'loading' ? '正在读取后台进度…' : '进度暂不可用' :
          page.data.total === 0 ? '暂无任务' : `共 ${page.data.total} 篇任务`}
      </span>
      <button type="button" className={buttonClass} onClick={reload} disabled={page.status === 'loading'} aria-label="刷新文献处理进度" hidden={!expanded}>
        <RefreshCw size={14} aria-hidden="true"/>
      </button>
      <button type="button" className={buttonClass} aria-expanded={preferences} onClick={() => setPreferences(value => !value)} hidden={!expanded && !preferences}>获取偏好</button>
    </div>
    {preferences ? <AcquisitionPreferences client={client} writable={writable}/> : null}
    {page.error !== null ? <p role="alert" className="break-words px-3 py-1 text-[var(--st-bad)]">{page.error}</p> : null}
    {actionError !== null ? <p role="alert" className="break-words px-3 py-1 text-[var(--st-bad)]">{actionError}</p> : null}
    {notice !== null ? <p role="status" className="px-3 py-1 text-muted">{notice}</p> : null}
    <div id="literature-processing-details" hidden={!expanded} className="max-h-60 overflow-y-auto px-3 pb-2">
      {page.data !== null && jobs.length > 0 ? <p className="flex flex-wrap gap-x-4 gap-y-1 py-2 text-muted tabular-nums" aria-label="本页处理概况">
        <span>元数据 {progress.metadata} 篇</span><span>PDF {progress.pdf} 篇</span>
        <span>全文索引 {progress.indexed} 篇</span><span>知识库 {progress.wiki} 篇</span>
      </p> : null}
      {page.data !== null && jobs.length === 0 ? <p className="py-2 text-muted">当前页无后台任务。仅导入元数据的文献不创建全文任务。</p> : null}
      <ul aria-label="逐篇处理进度" className="m-0 list-none p-0">
        {jobs.map(job => <li key={job.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t-[0.5px] border-line py-2" data-testid={`literature-processing-job-${job.id}`} aria-busy={pending === job.id}>
          <div className="min-w-0 flex-[1_1_240px]">
            <button type="button" onClick={() => onOpenItem(job.libraryItemId)} className={`${buttonClass} max-w-full break-words text-left text-ink`}>{job.title}</button>
            <p className="px-2 text-muted">{acquisitionStageLabels[job.stage]}：{acquisitionStatusLabels[job.status]}</p>
            <div className="p-2"><PipelineProgress stages={literaturePipeline(null, job)}/></div>
            {job.receipt ? <div className="break-words px-2 text-muted">
              <p>全文来源：{job.receipt.provider}，版本：{{published: '正式发表版', accepted: '接受稿', preprint: '预印本', unknown: '未标注'}[job.receipt.version]}，许可证：{job.receipt.license ?? '未标注'}</p>
              <details><summary className="cursor-pointer">下载凭证</summary>
                <p className="break-all">SHA-256：{job.receipt.sha256}</p>
                <p className="break-all">地址：{job.receipt.sourceUrl ?? '本地副本'}</p>
                <p className="break-all">文件：{job.receipt.relativePath ?? '未发布'}，{job.receipt.bytes} 字节</p>
              </details>
            </div> : null}
            {job.errorCode === null ? null : <p className="break-words px-2 text-[var(--st-bad)]">错误：{job.errorCode}</p>}
            {job.lastFailure ? <p className="break-words px-2 text-muted">最近下载失败：{job.lastFailure.provider}，{{rate_limited: '来源限流', temporary: '暂时不可用', permanent: '地址不可用', restricted: '访问受限', invalid_content: '内容校验失败'}[job.lastFailure.category]}</p> : null}
            {job.nextRetryAt === null ? null : <p className="break-words px-2 text-muted">计划重试：{job.nextRetryAt}</p>}
          </div>
          <div className="flex flex-wrap gap-1">
            {job.receipt?.relativePath ? <button type="button" className={buttonClass} onClick={() => {if (job.receipt?.relativePath) onOpenPdf(job.receipt.relativePath);}} aria-label={`打开 PDF：${job.title}`}>打开 PDF</button> : null}
            {canRetryAcquisition(job) ? <button type="button" className={buttonClass} disabled={!writable || pending !== null} onClick={() => void act(job, 'retry')} aria-label={`重试处理：${job.title}`}>重试</button> : null}
            {canCancelAcquisition(job) ? <button type="button" className={buttonClass} disabled={!writable || pending !== null} onClick={() => void act(job, 'cancel')} aria-label={`取消处理：${job.title}`}>取消处理</button> : null}
            {canRetryAcquisition(job) ? <button type="button" className={buttonClass} disabled={!writable || pending !== null} onClick={() => void act(job, 'attach')} aria-label={`手动补充 PDF：${job.title}`}>手动补充 PDF</button> : null}
            {pending === job.id ? <span className="self-center text-muted">正在提交…</span> : null}
          </div>
        </li>)}
      </ul>
      {page.data !== null && (offset > 0 || page.data.nextOffset !== null) ? <nav aria-label="处理任务分页" className="flex items-center justify-end gap-2 pt-2">
        <button type="button" className={buttonClass} disabled={offset === 0 || page.status === 'loading' || pending !== null} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</button>
        <span className="text-muted tabular-nums">第 {Math.floor(offset / 20) + 1} 页</span>
        <button type="button" className={buttonClass} disabled={page.data.nextOffset === null || page.status === 'loading' || pending !== null} onClick={() => {if (page.data?.nextOffset != null) setOffset(page.data.nextOffset);}}>下一页</button>
      </nav> : null}
    </div>
  </section>;
}
