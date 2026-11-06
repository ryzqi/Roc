import {useEffect, useRef, useState} from 'react';
import type {ResourceCapture, ResourceSummary} from '../../shared/schemas/research-resources';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';
import ResourceObservationView from './ResourceObservationView';
import ResourceAssociationsPanel from './ResourceAssociationsPanel';

export default function ResearchResourcesPanel({client, projectId, writable, onLockChange}: {
  client: RocClient; projectId: string; writable: boolean; onLockChange: (locked: boolean) => void;
}): React.JSX.Element {
  const [doi, setDoi] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ResourceSummary | null>(null);
  const [request, setRequest] = useState<ResourceCapture | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [associationLocked, setAssociationLocked] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const capture = useAsyncAction((input: ResourceCapture) => client.api.research.captureResource(input), {label: '查询资源元数据'});
  const cancel = useAsyncAction((input: ResourceCapture) => client.api.research.cancelResourceCapture({
    projectId: input.projectId, requestId: input.requestId
  }), {label: '取消资源查询'});
  const history = useAsyncResource(JSON.stringify([projectId, offset]),
    () => client.api.research.getResourceHistory({projectId, doi: null, offset, limit: 20}), {label: '读取资源历史'});
  const busy = capture.pending || cancel.pending;
  const locked = busy || associationLocked;
  useEffect(() => {
    onLockChange(locked || request !== null);
    return () => onLockChange(false);
  }, [locked, request, onLockChange]);
  const next = history.data?.nextOffset ?? null;
  const submit = async (input: ResourceCapture): Promise<void> => {
    setRequest(input); setNote(null); cancel.reset();
    const result = await capture.run(input);
    if (!mounted.current || !result.ok) return;
    setRequest(null); setSelected(result.data); setOffset(0); history.reload();
  };
  const stop = async (): Promise<void> => {
    const result = await cancel.run(request!);
    if (!mounted.current || !result.ok) return;
    setNote(result.data.cancelled ? '主进程已接收取消信号' : '没有进行中的查询，请检查保存历史');
    if (result.data.cancelled) setRequest(null);
    history.reload();
  };
  return <section aria-label="项目科研资源" className="space-y-3 px-3 py-2 text-[var(--font-body-size)]" data-testid="reader-resources-panel">
    <p className="text-muted">查询数据集或软件 DOI。元数据许可字段不构成内容下载授权。</p>
    <label className="block">资源 DOI
      <input className="w-full min-w-0 rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink" value={doi}
        disabled={locked || request !== null || !writable} onChange={event => setDoi(event.target.value)} maxLength={2048}/>
    </label>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={scholarlyButton} disabled={!writable || locked || request !== null || doi.trim() === ''}
        onClick={() => void submit({projectId, requestId: crypto.randomUUID(), doi})}>{capture.pending ? '查询资源中' : '查询并保存资源'}</button>
      {capture.pending && request !== null ? <button type="button" className={scholarlyButton} disabled={cancel.pending}
        onClick={() => void stop()}>取消资源查询</button> : null}
      {!busy && request !== null ? <>
        <button type="button" className={scholarlyButton} disabled={!writable || associationLocked} onClick={() => void submit(request)}>重试原资源请求</button>
        <button type="button" className={scholarlyButton} disabled={associationLocked} onClick={() => {
          setRequest(null); capture.reset(); cancel.reset(); setNote(null); history.reload();
        }}>开始新资源请求</button>
      </> : null}
      {!writable ? <span className="text-muted">项目只读</span> : null}
    </div>
    {capture.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{capture.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{cancel.error}</p>}
    {note === null ? null : <p role="status">{note}</p>}
    <details open={selected === null} data-testid="reader-resource-history">
      <summary className="cursor-pointer text-muted">资源观察历史{history.data === null ? '' : `（${history.data.total}）`}</summary>
      {history.status === 'loading' ? <p role="status">读取资源历史中</p> : null}
      {history.error === null ? null : <div role="alert"><p>{history.error}</p>
        <button type="button" className={scholarlyButton} onClick={history.reload}>重试资源历史</button></div>}
      {history.data === null ? null : <>
        {history.data.records.length === 0 ? <p className="text-muted">尚无资源观察</p> :
          <ul className="space-y-1 py-1">{history.data.records.map(resource => <li key={resource.id}>
            <button type="button" className={`${scholarlyButton} max-w-full text-left`} disabled={locked} aria-pressed={selected?.id === resource.id}
              onClick={() => {setSelected(resource); setNote(null);}}>
              <span className="break-all">{resource.request.doi}</span><span>{resource.queriedAt}</span>
              <span>{resource.status === 'ok' ? '元数据已保存' : '元数据不可用'}</span>
            </button>
          </li>)}</ul>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={scholarlyButton} disabled={locked || offset === 0}
            onClick={() => setOffset(value => Math.max(0, value - 20))}>资源历史上一页</button>
          <button type="button" className={scholarlyButton} disabled={locked || next === null} onClick={() => setOffset(next!)}>资源历史下一页</button>
          <button type="button" className={scholarlyButton} disabled={locked} onClick={history.reload}>刷新资源历史</button>
        </div>
      </>}
    </details>
    {selected === null ? null : <>
      <ResourceObservationView key={`observation:${selected.id}`} client={client} resource={selected}/>
      <ResourceAssociationsPanel key={`association:${selected.id}`} client={client} resource={selected}
        writable={writable} onLockChange={setAssociationLocked}/>
    </>}
  </section>;
}
