import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {openReviewCaptureSchema, type OpenReviewCapture, type OpenReviewQuery, type OpenReviewSummary} from '../../shared/schemas/research-openreview';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';
import OpenReviewObservationView from './OpenReviewObservationView';
import {LiteratureEditorBoundary, useLiteratureEditor} from './literature-editor-guard';

const inputStyle = 'w-full min-w-0 rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink';
export const openReviewQueryLabels = {note: '论文 Note', forum: '论坛与回复', invitation: 'Invitation', edits: '论文修改记录'};
type Props = {
  client: RocClient; projectId: string; writable: boolean; onLockChange: (locked: boolean) => void;
};
type Draft = {kind: OpenReviewQuery['kind']; target: string};
export default function OpenReviewPanel(props: Props): React.JSX.Element {
  return <LiteratureEditorBoundary key={props.projectId} projectId={props.projectId}>
    <OpenReviewContent {...props}/>
  </LiteratureEditorBoundary>;
}
function OpenReviewContent({client, projectId, writable, onLockChange}: Props): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>({kind: 'note', target: ''});
  const {kind, target} = draft;
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<OpenReviewSummary | null>(null);
  const [request, setRequest] = useState<OpenReviewCapture | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false), cancelling = useRef(false);
  const draftRef = useRef(draft), clean = useRef(draft), requestRef = useRef<OpenReviewCapture | null>(null);
  const isDirty = useCallback(() => draftRef.current.kind !== clean.current.kind || draftRef.current.target !== clean.current.target, []);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const capture = useAsyncAction((input: OpenReviewCapture) => client.api.research.captureOpenReview(input), {label: '查询 OpenReview'});
  const cancel = useAsyncAction((input: OpenReviewCapture) => client.api.research.cancelOpenReviewCapture({
    projectId: input.projectId, requestId: input.requestId
  }), {label: '取消 OpenReview 查询'});
  const history = useAsyncResource(JSON.stringify([projectId, offset]),
    () => client.api.research.getOpenReviewHistory({projectId, offset, limit: 20}), {label: '读取 OpenReview 历史'});
  const busy = capture.pending || cancel.pending;
  const uncertain = request !== null;
  const dirty = isDirty();
  const locked = busy || uncertain || dirty;
  const editor = useLiteratureEditor({label: 'OpenReview 查询', dirty: () => isDirty() || requestRef.current !== null,
    busy: () => submitting.current || cancelling.current, discard: () => discard()});
  const reportLock = useCallback(() => {
    onLockChange(submitting.current || cancelling.current || requestRef.current !== null || isDirty());
    editor.notify();
  }, [editor, isDirty, onLockChange]);
  useLayoutEffect(() => {onLockChange(locked);}, [locked, onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);
  const changeDraft = (patch: Partial<Draft>): void => {
    if (!writable || submitting.current || cancelling.current || requestRef.current !== null) return;
    draftRef.current = {...draftRef.current, ...patch}; setDraft(draftRef.current); reportLock();
  };
  const submit = async (input: OpenReviewCapture): Promise<void> => {
    if (!writable || submitting.current || cancelling.current ||
      (requestRef.current !== null && requestRef.current !== input)) return;
    submitting.current = true; requestRef.current = input; reportLock();
    setRequest(input); setNote(null); setValidation(null); cancel.reset();
    try {
      const result = await capture.run(input);
      if (!mounted.current || !result.ok) return;
      requestRef.current = null; clean.current = {kind: input.query.kind, target: input.query.target};
      draftRef.current = clean.current; setDraft(clean.current);
      setRequest(null); setSelected(result.data); setOffset(0); history.reload();
    } finally {
      submitting.current = false; if (mounted.current) reportLock();
    }
  };
  const create = (): void => {
    if (!writable || submitting.current || cancelling.current || requestRef.current !== null) return;
    const parsed = openReviewCaptureSchema.safeParse({projectId, requestId: crypto.randomUUID(),
      query: {...draftRef.current, after: null, limit: draftRef.current.kind === 'note' ? 1 : 50}});
    if (!parsed.success) {setValidation(kind === 'invitation' ? '填写完整 Invitation 标识。' : '填写合法的 OpenReview Note 或论坛 ID。'); return;}
    void submit(parsed.data);
  };
  const stop = async (): Promise<void> => {
    if (cancelling.current || !submitting.current || requestRef.current === null) return;
    cancelling.current = true; reportLock();
    try {
      const result = await cancel.run(requestRef.current);
      if (!mounted.current || !result.ok) return;
      setNote(result.data.cancelled ? '主进程已接收取消信号；等待查询结束。' : '没有进行中的查询，请检查观察历史');
      history.reload();
    } finally {
      cancelling.current = false; if (mounted.current) reportLock();
    }
  };
  const discard = (): void => {
    requestRef.current = null; draftRef.current = clean.current; reportLock();
    setRequest(null); setDraft(clean.current); setValidation(null); capture.reset(); cancel.reset(); setNote(null); history.reload();
  };
  const changeSource = (run: () => void): void => {
    if (submitting.current || cancelling.current || requestRef.current !== null || isDirty()) return;
    run();
  };
  return <section aria-label="OpenReview 公开来源" className="space-y-3 px-3 py-2 text-[length:var(--font-body-size)]" data-testid="reader-openreview-panel">
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      <label>查询范围<select value={kind} disabled={busy || uncertain || !writable} className={inputStyle}
        onChange={event => changeDraft({kind: event.target.value as OpenReviewQuery['kind']})}>
        {Object.entries(openReviewQueryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>{kind === 'invitation' ? 'Invitation 标识' : 'Note 或论坛 ID'}<input value={target} className={inputStyle}
        disabled={busy || uncertain || !writable} maxLength={kind === 'invitation' ? 512 : 128}
        onChange={event => changeDraft({target: event.target.value})}/></label>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={scholarlyButton} disabled={!writable || busy || uncertain || target === ''}
        onClick={create}>{capture.pending ? '查询 OpenReview 中' : '查询并保存公开来源'}</button>
      {capture.pending && request !== null ? <button type="button" className={scholarlyButton} disabled={cancel.pending}
        onClick={() => void stop()}>取消 OpenReview 查询</button> : null}
      {!busy && request !== null ? <>
        <button type="button" className={scholarlyButton} disabled={!writable} onClick={() => void submit(request)}>重试原 OpenReview 请求</button>
        <button type="button" className={scholarlyButton}
          onClick={() => editor.request(discard, '尚未保存的 OpenReview 查询和原请求将被放弃。')}>放弃原 OpenReview 请求</button>
      </> : null}
      {!busy && !uncertain && dirty ? <button type="button" className={scholarlyButton}
        onClick={() => editor.request(discard, '尚未保存的 OpenReview 查询范围和标识将被放弃。')}>放弃查询修改</button> : null}
      {!writable ? <span className="text-muted">项目只读</span> : null}
    </div>
    {validation === null ? null : <p role="alert">{validation}</p>}
    {capture.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{capture.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{cancel.error}</p>}
    {note === null ? null : <p role="status">{note}</p>}
    <details open={selected === null} data-testid="reader-openreview-history">
      <summary className="cursor-pointer text-muted tabular-nums">OpenReview 观察历史{history.data === null ? '' : `（${history.data.total.toLocaleString('zh-CN')} 条）`}</summary>
      {history.status === 'loading' ? <p role="status">读取 OpenReview 历史中</p> : null}
      {history.error === null ? null : <div role="alert"><p>{history.error}</p>
        <button type="button" className={scholarlyButton} onClick={history.reload}>重试 OpenReview 历史</button></div>}
      {history.data === null ? null : <>
        {history.data.records.length === 0 ? <p className="text-muted">尚无 OpenReview 观察</p> : <ul className="space-y-1 py-1">
          {history.data.records.map(record => <li key={record.id}><button type="button" className={`${scholarlyButton} max-w-full text-left`}
            disabled={locked || history.status === 'loading'} aria-pressed={selected?.id === record.id} onClick={() => changeSource(() => {
              clean.current = {kind: record.request.query.kind, target: record.request.query.target};
              draftRef.current = clean.current; setDraft(clean.current); setSelected(record); reportLock();
            })}>
            <span>{openReviewQueryLabels[record.request.query.kind]}</span><span className="break-all">{record.request.query.target}</span>
            <span>{record.queriedAt}</span><span>{record.status === 'ok' ? '公开来源已保存' : '公开来源不可用'}</span>
          </button></li>)}
        </ul>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={scholarlyButton} disabled={locked || history.status === 'loading' || offset === 0}
            onClick={() => changeSource(() => setOffset(value => Math.max(0, value - 20)))}>OpenReview 历史上一页</button>
          <button type="button" className={scholarlyButton} disabled={locked || history.status === 'loading' || history.data.nextOffset === null}
            onClick={() => changeSource(() => setOffset(history.data!.nextOffset!))}>OpenReview 历史下一页</button>
          <button type="button" className={scholarlyButton} disabled={locked} onClick={() => changeSource(history.reload)}>刷新 OpenReview 历史</button>
        </div>
      </>}
    </details>
    {selected === null ? null : <OpenReviewObservationView key={selected.id} client={client} observation={selected}
      writable={writable && !locked} onNextPage={() => {
        changeSource(() => {
          if (selected.request.query.kind !== 'note') void submit({projectId, requestId: crypto.randomUUID(),
            query: {...selected.request.query, after: selected.nextAfter}});
        });
      }}/>}
  </section>;
}
