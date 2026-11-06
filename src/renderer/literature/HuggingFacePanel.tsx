import {useEffect, useRef, useState} from 'react';
import {hfCaptureSchema, type HfCapture, type HfSummary} from '../../shared/schemas/research-huggingface';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';
import HuggingFaceObservationView from './HuggingFaceObservationView';

const hfInput = 'w-full min-w-0 rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink';
export default function HuggingFacePanel({client, projectId, writable, onLockChange}: {
  client: RocClient; projectId: string; writable: boolean; onLockChange: (locked: boolean) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<'model' | 'dataset'>('dataset');
  const [repo, setRepo] = useState('');
  const [revision, setRevision] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<HfSummary | null>(null);
  const [request, setRequest] = useState<HfCapture | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [reviewLocked, setReviewLocked] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const capture = useAsyncAction((input: HfCapture) => client.api.research.captureHuggingFace(input), {label: '查询 Hub 元数据'});
  const cancel = useAsyncAction((input: HfCapture) => client.api.research.cancelHuggingFaceCapture({
    projectId: input.projectId, requestId: input.requestId
  }), {label: '取消 Hub 查询'});
  const history = useAsyncResource(JSON.stringify([projectId, offset]),
    () => client.api.research.getHuggingFaceHistory({projectId, identity: null, offset, limit: 20}), {label: '读取 Hub 观察历史'});
  const busy = capture.pending || cancel.pending;
  const locked = busy || request !== null || reviewLocked;
  useEffect(() => {onLockChange(locked); return () => onLockChange(false);}, [locked, onLockChange]);
  const submit = async (input: HfCapture): Promise<void> => {
    setRequest(input); setNote(null); setValidation(null); cancel.reset();
    const result = await capture.run(input);
    if (!mounted.current || !result.ok) return;
    setRequest(null); setSelected(result.data); setOffset(0); history.reload();
  };
  const create = (): void => {
    const parsed = hfCaptureSchema.safeParse({projectId, requestId: crypto.randomUUID(), kind, repo, revision});
    if (!parsed.success) {setValidation('填写合法仓库名和完整的 40 位小写提交 SHA。'); return;}
    void submit(parsed.data);
  };
  const stop = async (): Promise<void> => {
    const result = await cancel.run(request!);
    if (!mounted.current || !result.ok) return;
    setNote(result.data.cancelled ? '主进程已接收取消查询信号' : '没有进行中的查询，请检查观察历史');
    history.reload();
  };
  return <section aria-label="Hugging Face 资源" className="space-y-3 px-3 py-2 text-[var(--font-body-size)]" data-testid="reader-hf-panel">
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      <label>仓库类型 <select value={kind} disabled={locked || !writable} className={hfInput}
        onChange={event => setKind(event.target.value as 'model' | 'dataset')}>
        <option value="dataset">数据集</option><option value="model">模型</option>
      </select></label>
      <label>Hub 仓库<input value={repo} className={hfInput} disabled={locked || !writable} maxLength={193}
        onChange={event => setRepo(event.target.value)}/></label>
    </div>
    <label className="block">提交 SHA<input value={revision} className={`${hfInput} font-mono`} disabled={locked || !writable}
      maxLength={40} onChange={event => setRevision(event.target.value)}/></label>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={scholarlyButton} disabled={!writable || locked || repo === '' || revision === ''}
        onClick={create}>{capture.pending ? '查询 Hub 中' : '查询并保存 Hub 元数据'}</button>
      {capture.pending && request !== null ? <button type="button" className={scholarlyButton} disabled={cancel.pending}
        onClick={() => void stop()}>取消 Hub 查询</button> : null}
      {!busy && request !== null ? <>
        <button type="button" className={scholarlyButton} disabled={!writable || reviewLocked} onClick={() => void submit(request)}>重试原 Hub 请求</button>
        <button type="button" className={scholarlyButton} disabled={reviewLocked} onClick={() => {
          setRequest(null); capture.reset(); cancel.reset(); setNote(null); history.reload();
        }}>放弃原 Hub 请求</button>
      </> : null}
      {!writable ? <span className="text-muted">项目只读</span> : null}
    </div>
    {validation === null ? null : <p role="alert">{validation}</p>}
    {capture.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{capture.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{cancel.error}</p>}
    {note === null ? null : <p role="status">{note}</p>}
    <details open={selected === null} data-testid="reader-hf-history">
      <summary className="cursor-pointer text-muted">Hub 观察历史{history.data === null ? '' : `（${history.data.total}）`}</summary>
      {history.status === 'loading' ? <p role="status">读取 Hub 历史中</p> : null}
      {history.error === null ? null : <div role="alert"><p>{history.error}</p>
        <button type="button" className={scholarlyButton} onClick={history.reload}>重试 Hub 历史</button></div>}
      {history.data === null ? null : <>
        {history.data.records.length === 0 ? <p className="text-muted">尚无 Hub 观察</p> : <ul className="space-y-1 py-1">
          {history.data.records.map(record => <li key={record.id}><button type="button" className={`${scholarlyButton} max-w-full text-left`}
            disabled={locked} aria-pressed={selected?.id === record.id} onClick={() => setSelected(record)}>
            <span className="break-all">{record.request.repo}</span><span>{record.queriedAt}</span>
            <span>{record.status === 'ok' ? '元数据已保存' : '元数据不可用'}</span>
          </button></li>)}
        </ul>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={scholarlyButton} disabled={locked || offset === 0}
            onClick={() => setOffset(value => Math.max(0, value - 20))}>Hub 历史上一页</button>
          <button type="button" className={scholarlyButton} disabled={locked || history.data.nextOffset === null}
            onClick={() => setOffset(history.data!.nextOffset!)}>Hub 历史下一页</button>
          <button type="button" className={scholarlyButton} disabled={locked} onClick={history.reload}>刷新 Hub 历史</button>
        </div>
      </>}
    </details>
    {selected === null ? null : <HuggingFaceObservationView key={selected.id} client={client} observation={selected}
      writable={writable && !busy && request === null} onLockChange={setReviewLocked}/>}
  </section>;
}
