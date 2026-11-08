import {useEffect, useRef, useState} from 'react';
import type {ResearchLibraryItem} from '../../shared/types';
import type {ScholarlyCapture, ScholarlyProvider, ScholarlySnapshotSummary} from '../../shared/schemas/research-scholarly-relations';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import type {RocClient} from '../shared/roc-client';
import ScholarlySnapshotView, {providerNames, scholarlyButton} from './ScholarlySnapshotView';

export default function ScholarlyRelationsPanel({client, projectId, item, writable}: {
  client: RocClient; projectId: string; item: ResearchLibraryItem; writable: boolean;
}): React.JSX.Element {
  const [sources, setSources] = useState<ScholarlyProvider[]>(['openalex', 'crossref', 'semantic_scholar']);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [selected, setSelected] = useState<ScholarlySnapshotSummary | null>(null);
  const [request, setRequest] = useState<ScholarlyCapture | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const capture = useAsyncAction((input: ScholarlyCapture) => client.api.research.captureScholarlyRelations(input),
    {label: '查询学术关系'});
  const cancel = useAsyncAction((input: ScholarlyCapture) => client.api.research.cancelScholarlyRelations({
    projectId: input.projectId, itemId: input.itemId, requestId: input.requestId
  }), {label: '取消学术关系查询'});
  const history = useAsyncResource(JSON.stringify([projectId, item.id, historyOffset]),
    () => client.api.research.getScholarlyHistory({projectId, itemId: item.id, offset: historyOffset, limit: 20}),
    {label: '读取学术关系历史'});
  const busy = capture.pending || cancel.pending;
  const historyNext = history.data?.nextOffset ?? null;
  const blocked = !writable ? '项目只读' : item.archived ? '文献已归档' :
    !item.projectIds.includes(projectId) ? '文献未关联当前项目' : item.metadata.doi === null ? '文献缺少 DOI' :
    sources.length === 0 ? '请选择来源' : null;
  const submit = async (input: ScholarlyCapture): Promise<void> => {
    setRequest(input);
    setNote(null);
    const result = await capture.run(input);
    if (!mounted.current) return;
    if (result.ok) {
      setRequest(null);
      setSelected(result.data);
      setHistoryOffset(0);
      history.reload();
    }
  };
  const query = (offset = 0, nextSources = sources, limit = 100): void => {
    cancel.reset();
    void submit({projectId, itemId: item.id, expectedRevision: item.revision,
      requestId: crypto.randomUUID(), sources: nextSources, offset, limit});
  };
  const stop = async (): Promise<void> => {
    if (request === null) return;
    const result = await cancel.run(request);
    if (!mounted.current || !result.ok) return;
    setNote(result.data.cancelled ? '主进程已接收取消信号' : '没有进行中的查询，请检查保存历史');
    if (result.data.cancelled) setRequest(null);
    history.reload();
  };
  return <section aria-label="学术关系" className="space-y-3 px-3 py-2 text-[length:var(--font-body-size)]" data-testid="reader-scholarly-panel">
    <fieldset disabled={busy} className="flex flex-wrap items-center gap-3">
      <legend className="mb-1 text-muted">查询来源</legend>
      {(Object.keys(providerNames) as ScholarlyProvider[]).map(source => <label key={source} className="flex items-center gap-1">
        <input type="checkbox" checked={sources.includes(source)} onChange={event => {
          setSources(current => event.target.checked ? [...current, source] : current.filter(value => value !== source));
          setRequest(null); capture.reset(); cancel.reset(); setNote(null);
        }}/>{providerNames[source]}
      </label>)}
    </fieldset>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={scholarlyButton} disabled={busy || blocked !== null} onClick={() => query()}>
        {capture.pending ? '查询中' : '查询并保存'}
      </button>
      {capture.pending && request !== null ? <button type="button" className={scholarlyButton}
        disabled={cancel.pending} onClick={() => void stop()}>取消查询</button> : null}
      {!busy && request !== null && capture.error !== null ? <button type="button" className={scholarlyButton}
        disabled={!writable} onClick={() => void submit(request)}>重试原请求</button> : null}
      {blocked === null ? null : <span className="text-muted">{blocked}</span>}
    </div>
    <p className="text-muted text-[length:var(--font-meta-size)]">来源观察不构成科研审批。未报告撤稿不等于没有撤稿。</p>
    {capture.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{capture.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{cancel.error}</p>}
    {note === null ? null : <p role="status" className="text-muted">{note}</p>}
    <details open={selected === null} data-testid="reader-scholarly-history">
      <summary className="cursor-pointer text-muted">保存历史{history.data === null ? '' : `（${history.data.total}）`}</summary>
      {history.status === 'loading' ? <p role="status">读取历史中</p> : null}
      {history.error === null ? null : <div role="alert"><p>{history.error}</p>
        <button type="button" className={scholarlyButton} onClick={history.reload}>重试历史</button></div>}
      {history.data === null ? null : <>
        {history.data.records.length === 0 ? <p className="py-1 text-muted">尚无保存记录</p> :
          <ul className="space-y-1 py-1">{history.data.records.map(record => <li key={record.id}>
            <button type="button" disabled={busy} aria-pressed={selected?.id === record.id} className={`${scholarlyButton} text-left`}
              onClick={() => {setSelected(record); setNote(null);}}>
              <span>{record.queriedAt}</span><span>文献版本 {record.itemRevision}</span>
              <span>{record.status === 'complete' ? '本次请求成功' : record.status === 'partial' ? '部分来源失败' : '来源请求失败'}</span>
            </button>
          </li>)}</ul>}
        <div className="flex gap-2">
          <button type="button" className={scholarlyButton} disabled={busy || historyOffset === 0}
            onClick={() => setHistoryOffset(current => Math.max(0, current - 20))}>历史上一页</button>
          <button type="button" className={scholarlyButton} disabled={busy || historyNext === null}
            onClick={() => setHistoryOffset(historyNext!)}>历史下一页</button>
          <button type="button" className={scholarlyButton} disabled={busy} onClick={history.reload}>刷新历史</button>
        </div>
      </>}
    </details>
    {selected === null ? null : <ScholarlySnapshotView key={selected.id} client={client} snapshot={selected}
      currentRevision={item.revision} busy={busy} canQuery={writable && !item.archived && item.projectIds.includes(projectId) && item.metadata.doi !== null}
      onNextPage={(offset, limit) => query(offset, ['semantic_scholar'], limit)}/>}
  </section>;
}
