import {useEffect, useRef, useState} from 'react';
import {openReviewCaptureSchema, type OpenReviewCapture, type OpenReviewQuery, type OpenReviewSummary} from '../../shared/schemas/research-openreview';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';
import OpenReviewObservationView from './OpenReviewObservationView';

const inputStyle = 'w-full min-w-0 rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink';
export const openReviewQueryLabels = {note: '论文 Note', forum: '论坛与回复', invitation: 'Invitation', edits: '论文修改记录'};
export default function OpenReviewPanel({client, projectId, writable, onLockChange}: {
  client: RocClient; projectId: string; writable: boolean; onLockChange: (locked: boolean) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<OpenReviewQuery['kind']>('note');
  const [target, setTarget] = useState('');
  const [dirty, setDirty] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<OpenReviewSummary | null>(null);
  const [request, setRequest] = useState<OpenReviewCapture | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const capture = useAsyncAction((input: OpenReviewCapture) => client.api.research.captureOpenReview(input), {label: '查询 OpenReview'});
  const cancel = useAsyncAction((input: OpenReviewCapture) => client.api.research.cancelOpenReviewCapture({
    projectId: input.projectId, requestId: input.requestId
  }), {label: '取消 OpenReview 查询'});
  const history = useAsyncResource(JSON.stringify([projectId, offset]),
    () => client.api.research.getOpenReviewHistory({projectId, offset, limit: 20}), {label: '读取 OpenReview 历史'});
  const busy = capture.pending || cancel.pending;
  const uncertain = request !== null;
  const locked = busy || uncertain || dirty;
  useEffect(() => {onLockChange(locked); return () => onLockChange(false);}, [locked, onLockChange]);
  const submit = async (input: OpenReviewCapture): Promise<void> => {
    setRequest(input); setNote(null); setValidation(null); cancel.reset();
    const result = await capture.run(input);
    if (!mounted.current || !result.ok) return;
    setRequest(null); setDirty(false); setKind(input.query.kind); setTarget(input.query.target);
    setSelected(result.data); setOffset(0); history.reload();
  };
  const create = (): void => {
    const parsed = openReviewCaptureSchema.safeParse({projectId, requestId: crypto.randomUUID(),
      query: {kind, target, after: null, limit: kind === 'note' ? 1 : 50}});
    if (!parsed.success) {setValidation(kind === 'invitation' ? '填写完整 Invitation 标识。' : '填写合法的 OpenReview Note 或论坛 ID。'); return;}
    void submit(parsed.data);
  };
  const stop = async (): Promise<void> => {
    const result = await cancel.run(request!);
    if (!mounted.current || !result.ok) return;
    setNote(result.data.cancelled ? '主进程已接收取消查询信号' : '没有进行中的查询，请检查观察历史');
    history.reload();
  };
  return <section aria-label="OpenReview 公开来源" className="space-y-3 px-3 py-2 text-[length:var(--font-body-size)]" data-testid="reader-openreview-panel">
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      <label>查询范围<select value={kind} disabled={busy || uncertain || !writable} className={inputStyle}
        onChange={event => {setKind(event.target.value as OpenReviewQuery['kind']); setDirty(true);}}>
        {Object.entries(openReviewQueryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>{kind === 'invitation' ? 'Invitation 标识' : 'Note 或论坛 ID'}<input value={target} className={inputStyle}
        disabled={busy || uncertain || !writable} maxLength={kind === 'invitation' ? 512 : 128}
        onChange={event => {setTarget(event.target.value); setDirty(true);}}/></label>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={scholarlyButton} disabled={!writable || busy || uncertain || target === ''}
        onClick={create}>{capture.pending ? '查询 OpenReview 中' : '查询并保存公开来源'}</button>
      {capture.pending && request !== null ? <button type="button" className={scholarlyButton} disabled={cancel.pending}
        onClick={() => void stop()}>取消 OpenReview 查询</button> : null}
      {!busy && request !== null ? <>
        <button type="button" className={scholarlyButton} disabled={!writable} onClick={() => void submit(request)}>重试原 OpenReview 请求</button>
        <button type="button" className={scholarlyButton} onClick={() => {
          setRequest(null); setDirty(false); capture.reset(); cancel.reset(); setNote(null); history.reload();
        }}>放弃原 OpenReview 请求</button>
      </> : null}
      {!busy && !uncertain && dirty ? <button type="button" className={scholarlyButton} onClick={() => {
        setKind(selected?.request.query.kind ?? 'note'); setTarget(selected?.request.query.target ?? '');
        setDirty(false); setValidation(null);
      }}>放弃查询修改</button> : null}
      {!writable ? <span className="text-muted">项目只读</span> : null}
    </div>
    {validation === null ? null : <p role="alert">{validation}</p>}
    {capture.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{capture.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{cancel.error}</p>}
    {note === null ? null : <p role="status">{note}</p>}
    <details open={selected === null} data-testid="reader-openreview-history">
      <summary className="cursor-pointer text-muted">OpenReview 观察历史{history.data === null ? '' : `（${history.data.total}）`}</summary>
      {history.status === 'loading' ? <p role="status">读取 OpenReview 历史中</p> : null}
      {history.error === null ? null : <div role="alert"><p>{history.error}</p>
        <button type="button" className={scholarlyButton} onClick={history.reload}>重试 OpenReview 历史</button></div>}
      {history.data === null ? null : <>
        {history.data.records.length === 0 ? <p className="text-muted">尚无 OpenReview 观察</p> : <ul className="space-y-1 py-1">
          {history.data.records.map(record => <li key={record.id}><button type="button" className={`${scholarlyButton} max-w-full text-left`}
            disabled={locked || history.status === 'loading'} aria-pressed={selected?.id === record.id} onClick={() => {
              setSelected(record); setKind(record.request.query.kind); setTarget(record.request.query.target);
            }}>
            <span>{openReviewQueryLabels[record.request.query.kind]}</span><span className="break-all">{record.request.query.target}</span>
            <span>{record.queriedAt}</span><span>{record.status === 'ok' ? '公开来源已保存' : '公开来源不可用'}</span>
          </button></li>)}
        </ul>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={scholarlyButton} disabled={locked || history.status === 'loading' || offset === 0}
            onClick={() => setOffset(value => Math.max(0, value - 20))}>OpenReview 历史上一页</button>
          <button type="button" className={scholarlyButton} disabled={locked || history.status === 'loading' || history.data.nextOffset === null}
            onClick={() => setOffset(history.data!.nextOffset!)}>OpenReview 历史下一页</button>
          <button type="button" className={scholarlyButton} disabled={locked} onClick={history.reload}>刷新 OpenReview 历史</button>
        </div>
      </>}
    </details>
    {selected === null ? null : <OpenReviewObservationView key={selected.id} client={client} observation={selected}
      writable={writable && !locked} onNextPage={() => {
        if (selected.request.query.kind !== 'note') void submit({projectId, requestId: crypto.randomUUID(),
          query: {...selected.request.query, after: selected.nextAfter}});
      }}/>}
  </section>;
}
