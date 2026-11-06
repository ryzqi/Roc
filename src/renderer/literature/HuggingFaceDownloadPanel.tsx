import {useEffect, useRef, useState} from 'react';
import type {HfSummary} from '../../shared/schemas/research-huggingface';
import {hfDownloadStartSchema, type HfDownloadStart, type HfDownloadReceipt} from '../../shared/schemas/research-huggingface-downloads';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';

const field = 'w-full min-w-0 rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink';
const states: Record<HfDownloadReceipt['state'], string> = {
  running: '下载进行中', completed: '下载完成', failed: '下载失败', cancelled: '下载已取消', interrupted: '下载已中断'
};
export function HuggingFaceDownloadReceiptView({receipt}: {receipt: HfDownloadReceipt}): React.JSX.Element {
  return <section aria-label="下载回执" className="space-y-2" data-testid="reader-hf-download-receipt">
    <p role="status">{states[receipt.state]}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted tabular-nums">
      <dt>最后记录的传输量</dt><dd>{receipt.lastRecordedTransferredBytes} 字节</dd>
      <dt>已验证内容</dt><dd>{receipt.verifiedBytes} 字节（{receipt.files.length}/{receipt.selectedFiles.length} 个文件）</dd>
      <dt>授权上限</dt><dd>{receipt.request.maxBytes} 字节</dd>
      <dt>超时</dt><dd>{receipt.request.timeoutMs / 1000} 秒</dd>
      <dt>创建时间</dt><dd>{receipt.createdAt}</dd><dt>更新时间</dt><dd>{receipt.updatedAt}</dd>
      <dt>结束时间</dt><dd>{receipt.finishedAt ?? '尚未结束'}</dd>
      {receipt.errorCode === null ? null : <><dt>错误</dt><dd className="break-all text-[var(--st-bad)]">{receipt.errorCode}</dd></>}
    </dl>
    {receipt.files.length === 0 ? <p className="text-muted">尚无已验证文件</p> : <ul className="space-y-1" data-testid="reader-hf-verified-files">
      {receipt.files.map(file => <li key={file.storageName} className="break-all">
        <p>{file.source.path}（{file.source.size} 字节）</p><p className="font-mono text-muted">SHA-256 {file.sha256}</p>
      </li>)}
    </ul>}
    <details data-testid="reader-hf-download-authorization"><summary className="cursor-pointer text-muted">固定授权与请求回执</summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-1 text-muted">
        <dt>下载 ID</dt><dd className="break-all">{receipt.id}</dd>
        <dt>主进程用户</dt><dd>{receipt.actor.id}</dd>
        <dt>许可审核</dt><dd className="break-words whitespace-pre-wrap">{receipt.request.licenseReview}</dd>
        <dt>固定提交</dt><dd className="break-all font-mono">{receipt.observation.request.revision}</dd>
        <dt>观察 SHA-256</dt><dd className="break-all font-mono">{receipt.request.expectedContentHash}</dd>
        <dt>回执版本</dt><dd>{receipt.revision}</dd>
        <dt>回执 SHA-256</dt><dd className="break-all font-mono">{receipt.contentHash}</dd>
      </dl>
      <ul className="space-y-1 text-muted">{receipt.requests.map((request, index) => <li key={index} className="break-all">
        {request.filePath} {request.host} {request.status === null ? '未取得 HTTP 状态' : `HTTP ${request.status}`} {request.errorCode}
      </li>)}</ul>
    </details>
  </section>;
}
export default function HuggingFaceDownloadPanel({client, observation, paths, selectedBytes, sourceReady, writable, onLockChange, onSelectionLockChange, onClear}: {
  client: RocClient; observation: HfSummary; paths: string[]; selectedBytes: number; sourceReady: boolean;
  writable: boolean; onLockChange: (locked: boolean) => void; onSelectionLockChange: (locked: boolean) => void; onClear: () => void;
}): React.JSX.Element {
  const [limit, setLimit] = useState('64');
  const [timeout, setTimeoutSeconds] = useState('120');
  const [review, setReview] = useState('');
  const [request, setRequest] = useState<HfDownloadStart | null>(null);
  const [initial, setInitial] = useState<HfDownloadReceipt | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [validation, setValidation] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const start = useAsyncAction((input: HfDownloadStart) => client.api.research.startHuggingFaceDownload(input), {label: '开始审核下载'});
  const cancel = useAsyncAction((receipt: HfDownloadReceipt) => client.api.research.cancelHuggingFaceDownload({
    projectId: receipt.projectId, downloadId: receipt.id
  }), {label: '取消下载'});
  const read = useAsyncResource(initial === null ? null : JSON.stringify([observation.projectId, observation.id, initial.id]),
    () => client.api.research.getHuggingFaceDownload({projectId: observation.projectId, downloadId: initial!.id}), {label: '读取下载回执'});
  const history = useAsyncResource(JSON.stringify([observation.projectId, observation.id, historyOffset]),
    () => client.api.research.getHuggingFaceDownloads({projectId: observation.projectId, observationId: observation.id,
      offset: historyOffset, limit: 20}), {label: '读取下载历史'});
  const receipt = read.data ?? initial;
  const busy = start.pending || cancel.pending;
  const dirty = paths.length > 0 || review !== '' || limit !== '64' || timeout !== '120';
  const locked = busy || request !== null || dirty;
  useEffect(() => {onLockChange(locked); return () => onLockChange(false);}, [locked, onLockChange]);
  // Refresh only actual persisted state. Stop after a failed read or terminal receipt.
  useEffect(() => {
    if (read.status !== 'ready' || read.data?.state !== 'running') return;
    const timer = setTimeout(read.reload, 1000);
    return () => clearTimeout(timer);
  }, [read.status, read.data, read.reload]);
  const submit = async (input: HfDownloadStart): Promise<void> => {
    setRequest(input); setNote(null); setValidation(null); cancel.reset();
    const result = await start.run(input);
    if (!mounted.current || !result.ok) return;
    setRequest(null); setInitial(result.data); setReview(''); setLimit('64'); setTimeoutSeconds('120'); onClear();
    setHistoryOffset(0); history.reload(); read.reload();
  };
  const create = (): void => {
    if (limit.trim() === '' || timeout.trim() === '') {setValidation('填写下载字节上限和超时。'); return;}
    const parsed = hfDownloadStartSchema.safeParse({projectId: observation.projectId, requestId: crypto.randomUUID(),
      observationId: observation.id, expectedContentHash: observation.contentHash, paths,
      maxBytes: Number(limit) * 1024 * 1024, timeoutMs: Number(timeout) * 1000, licenseReview: review});
    if (!parsed.success || parsed.data.maxBytes < selectedBytes) {
      setValidation('选择 1–20 个文件，填写足够的 0–512 MiB 上限、1–120 秒超时和许可审核。'); return;
    }
    void submit(parsed.data);
  };
  const clear = (): void => {setRequest(null); setReview(''); setLimit('64'); setTimeoutSeconds('120');
    setValidation(null); start.reset(); cancel.reset(); setNote(null); onClear(); history.reload();};
  const stop = async (): Promise<void> => {
    const result = await cancel.run(receipt!);
    if (!mounted.current || !result.ok) return;
    setNote(result.data.cancelled ? '主进程已接收取消下载信号' : '没有进行中的下载，请刷新回执');
    read.reload(); history.reload();
  };
  const metadata = observation.metadata;
  const allowed = observation.status === 'ok' && metadata !== null && metadata.private === false && metadata.gated === false && metadata.disabled !== true;
  const frozen = busy || request !== null;
  useEffect(() => {onSelectionLockChange(frozen); return () => onSelectionLockChange(false);}, [frozen, onSelectionLockChange]);
  return <section aria-label="审核下载" className="space-y-2 border-t-[0.5px] border-line pt-2" data-testid="reader-hf-download-panel">
    {allowed ? <>
      <p className="tabular-nums">已选 {paths.length} 个文件，{selectedBytes} 字节</p>
      <div className="grid grid-cols-2 gap-2">
        <label>下载上限（MiB）<input type="number" min="0" max="512" step="1" value={limit} className={field}
          disabled={!writable || frozen} onChange={event => setLimit(event.target.value)}/></label>
        <label>超时（秒）<input type="number" min="1" max="120" step="1" value={timeout} className={field}
          disabled={!writable || frozen} onChange={event => setTimeoutSeconds(event.target.value)}/></label>
      </div>
      <label className="block">许可与文件审核<textarea value={review} className={field} rows={2} maxLength={8192}
        disabled={!writable || frozen} onChange={event => setReview(event.target.value)}/></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={scholarlyButton} disabled={!writable || !sourceReady || frozen || paths.length === 0 || review.trim() === ''}
          onClick={create}>{start.pending ? '提交下载中' : '批准并下载所选文件'}</button>
        {!busy && request !== null ? <button type="button" className={scholarlyButton} disabled={!writable}
          onClick={() => void submit(request)}>重试原下载请求</button> : null}
        {dirty || request !== null ? <button type="button" className={scholarlyButton} disabled={busy}
          onClick={clear}>放弃下载审核</button> : null}
      </div>
    </> : <p className="text-muted">访问条件不允许匿名下载</p>}
    {validation === null ? null : <p role="alert">{validation}</p>}
    {start.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{start.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{cancel.error}</p>}
    {note === null ? null : <p role="status">{note}</p>}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{read.error}</p>}
    {receipt === null ? null : <>
      <HuggingFaceDownloadReceiptView receipt={receipt}/>
      <div className="flex flex-wrap gap-2">
        {receipt.state === 'running' ? <button type="button" className={scholarlyButton} disabled={cancel.pending}
          onClick={() => void stop()}>取消 Hub 下载</button> : null}
        <button type="button" className={scholarlyButton} disabled={busy} onClick={() => {read.reload(); history.reload();}}>刷新下载回执</button>
      </div>
    </>}
    <details open={initial === null} data-testid="reader-hf-download-history">
      <summary className="cursor-pointer text-muted">下载历史{history.data === null ? '' : `（${history.data.total}）`}</summary>
      {history.status === 'loading' ? <p role="status">读取下载历史中</p> : null}
      {history.error === null ? null : <div role="alert"><p>{history.error}</p>
        <button type="button" className={scholarlyButton} onClick={history.reload}>重试下载历史</button></div>}
      {history.data === null ? null : <>
        {history.data.records.length === 0 ? <p className="text-muted">尚无下载记录</p> : <ul className="space-y-1 py-1">
          {history.data.records.map(record => <li key={record.id}><button type="button" className={`${scholarlyButton} max-w-full text-left`}
            disabled={locked} aria-pressed={initial?.id === record.id} onClick={() => {setInitial(record); setNote(null); read.reload();}}>
            <span>{states[record.state]}</span><span>{record.createdAt}</span><span className="break-all">{record.id}</span>
          </button></li>)}
        </ul>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={scholarlyButton} disabled={locked || historyOffset === 0}
            onClick={() => setHistoryOffset(value => Math.max(0, value - 20))}>下载历史上一页</button>
          <button type="button" className={scholarlyButton} disabled={locked || history.data.nextOffset === null}
            onClick={() => setHistoryOffset(history.data!.nextOffset!)}>下载历史下一页</button>
          <button type="button" className={scholarlyButton} disabled={busy} onClick={history.reload}>刷新下载历史</button>
        </div>
      </>}
    </details>
  </section>;
}
