import {useCallback, useRef, useState} from 'react';
import type {z} from 'zod';
import type {HfSummary, hfFileSchema} from '../../shared/schemas/research-huggingface';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';
import HuggingFaceDownloadPanel from './HuggingFaceDownloadPanel';
import {useLiteratureEditor} from './literature-editor-guard';

type File = z.infer<typeof hfFileSchema>;
const reported = (value: string | boolean | null): string => value === null ? '未报告' : String(value);
export default function HuggingFaceObservationView({client, observation, writable, onLockChange}: {
  client: RocClient; observation: HfSummary; writable: boolean; onLockChange: (locked: boolean) => void;
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<Map<string, File>>(() => new Map());
  const [selectionLocked, setSelectionLocked] = useState(false);
  const selectionRef = useRef(selection), selectionLock = useRef(false);
  const read = useAsyncResource(JSON.stringify([observation.projectId, observation.id, offset]),
    () => client.api.research.getHuggingFaceObservation({projectId: observation.projectId, observationId: observation.id, offset, limit: 50}),
    {label: '读取 Hub 文件清单'});
  const editor = useLiteratureEditor({label: 'Hub 文件选择', dirty: () => selectionRef.current.size > 0,
    busy: () => selectionLock.current, discard: () => clear()});
  const clear = useCallback(() => {
    selectionRef.current = new Map(); setSelection(selectionRef.current); editor.notify();
  }, [editor]);
  const onSelectionLock = useCallback((locked: boolean) => {
    selectionLock.current = locked; setSelectionLocked(locked); editor.notify();
  }, [editor]);
  const metadata = observation.metadata;
  const sourceReady = read.status === 'ready' && read.data?.observation.contentHash === observation.contentHash;
  const allowed = metadata !== null && metadata.private === false && metadata.gated === false && metadata.disabled !== true;
  const paths = [...selection.keys()];
  const selectedBytes = [...selection.values()].reduce((sum, file) => sum + file.size, 0);
  const change = (file: File, checked: boolean): void => {
    if (!writable || !allowed || !sourceReady || selectionLock.current || file.size > 256 * 1024 * 1024 ||
      (checked && !selectionRef.current.has(file.path) && selectionRef.current.size >= 20)) return;
    const next = new Map(selectionRef.current);
    if (checked) next.set(file.path, file); else next.delete(file.path);
    selectionRef.current = next; setSelection(next); editor.notify();
    if (next.size > 0) onLockChange(true);
  };
  return <section aria-label="Hub 观察" className="space-y-2" data-testid="reader-hf-observation">
    <h3 className="break-all font-medium">{observation.request.repo}</h3>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted tabular-nums">
      <dt>仓库类型</dt><dd>{observation.request.kind === 'dataset' ? '数据集' : '模型'}</dd>
      <dt>固定提交</dt><dd className="break-all font-mono">{observation.request.revision}</dd>
      <dt>查询时间</dt><dd>{observation.queriedAt}</dd>
      <dt>获取时间</dt><dd>{reported(observation.fetchedAt)}</dd>
      <dt>本次观察</dt><dd>{observation.status === 'ok' ? '元数据已保存' : '元数据不可用'}</dd>
      <dt>文件数量</dt><dd>{observation.fileCount === null ? '未知' : `${observation.fileCount.toLocaleString('zh-CN')} 个`}</dd>
      {observation.errorCode === null ? null : <><dt>错误</dt><dd className="break-all text-[var(--st-bad)]">{observation.errorCode}</dd></>}
    </dl>
    {metadata === null ? null : <details data-testid="reader-hf-access">
      <summary className="cursor-pointer text-muted">来源许可与访问条件</summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-1 text-muted">
        <dt>私有仓库</dt><dd>{reported(metadata.private)}</dd>
        <dt>Gated 条件</dt><dd>{reported(metadata.gated)}</dd>
        <dt>已禁用</dt><dd>{reported(metadata.disabled)}</dd>
        <dt>许可</dt><dd className="break-words">{Array.isArray(metadata.license) ? metadata.license.join(', ') : reported(metadata.license)}</dd>
        <dt>许可名称</dt><dd className="break-words">{reported(metadata.licenseName)}</dd>
        <dt>许可链接</dt><dd className="break-all">{reported(metadata.licenseLink)}</dd>
        <dt>来源修改时间</dt><dd>{reported(metadata.lastModified)}</dd>
      </dl>
    </details>}
    <details data-testid="reader-hf-observation-receipts">
      <summary className="cursor-pointer text-muted">元数据请求回执</summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-1 text-muted">
        <dt>观察 SHA-256</dt><dd className="break-all font-mono">{observation.contentHash}</dd>
        <dt>响应 SHA-256</dt><dd className="break-all font-mono">{reported(observation.responseHash)}</dd>
        <dt>端点</dt><dd className="break-all">{observation.endpoint}</dd>
        <dt>缓存</dt><dd>{observation.cache === 'hit' ? '命中' : '未命中'}</dd>
        <dt>实际 GET</dt><dd>{observation.requests.length} 次</dd>
        <dt>治理状态</dt><dd>{observation.governance.state}</dd>
      </dl>
    </details>
    <details open data-testid="reader-hf-files-disclosure">
      <summary className="cursor-pointer text-muted">固定版本文件</summary>
      {read.status === 'loading' ? <p role="status">读取文件中</p> : null}
      {read.error === null ? null : <div role="alert"><p>{read.error}</p>
        <button type="button" className={scholarlyButton} onClick={read.reload}>重试 Hub 文件读取</button></div>}
      {read.data === null ? null : <>
        {read.data.total === null ? <p className="text-muted">文件数量未知</p> : read.data.total === 0 ? <p className="text-muted">来源报告 0 个文件</p> : null}
        <ul className="space-y-2 py-1" data-testid="reader-hf-files">
          {read.data.files.map(file => <li key={file.path} className="border-b-[0.5px] border-line pb-1">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={selection.has(file.path)} onChange={event => change(file, event.target.checked)}
                disabled={!writable || !allowed || !sourceReady || selectionLocked || file.size > 256 * 1024 * 1024 ||
                  !selection.has(file.path) && selection.size >= 20}/>
              <span className="min-w-0 break-all">{file.path}<span className="ml-2 text-muted tabular-nums">{file.size.toLocaleString('zh-CN')} 字节</span></span>
            </label>
            <details className="text-muted"><summary className="cursor-pointer">{file.lfs === null ? 'Git 文件标识' : 'LFS 内容标识'}</summary>
              <p className="break-all font-mono">Git blob SHA-1 {file.blobId}</p>
              {file.lfs === null ? null : <p className="break-all font-mono">LFS SHA-256 {file.lfs.sha256}</p>}
            </details>
          </li>)}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={scholarlyButton} disabled={selectionLocked || read.status === 'loading' || offset === 0}
            onClick={() => {if (!selectionLock.current) setOffset(value => Math.max(0, value - 50));}}>Hub 文件上一页</button>
          <button type="button" className={scholarlyButton} disabled={selectionLocked || read.status === 'loading' || read.data.nextOffset === null}
            onClick={() => {if (!selectionLock.current && read.data?.nextOffset != null) setOffset(read.data.nextOffset);}}>Hub 文件下一页</button>
        </div>
      </>}
    </details>
    {selection.size === 0 ? null : <p className="break-all text-muted" data-testid="reader-hf-selected">所选文件：{paths.join(', ')}</p>}
    <HuggingFaceDownloadPanel client={client} observation={observation} paths={paths} selectedBytes={selectedBytes}
      sourceReady={sourceReady} writable={writable} onLockChange={onLockChange} onSelectionLockChange={onSelectionLock} onClear={clear}/>
  </section>;
}
