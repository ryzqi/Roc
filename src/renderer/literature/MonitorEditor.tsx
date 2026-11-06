import {useEffect, useRef, useState} from 'react';
import type {ResearchLibraryItem} from '../../shared/types';
import {monitorSaveSchema, type MonitorSave, type MonitorQuery, type MonitorVersion, type ResearchMonitor,
  type MonitorAlert, type MonitorCheck} from '../../shared/schemas/research-monitors';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import type {IpcLikeResult} from '../app/loaded-state';
import MonitorHistory, {monitorButton, monitorStatus, MonitorReadState} from './MonitorHistory';

type Api = RocClient['api']['research'];
type Command =
  | {kind: 'save'; input: MonitorSave}
  | {kind: 'control'; input: Parameters<Api['controlMonitor']>[0]}
  | {kind: 'check'; input: Parameters<Api['checkMonitor']>[0]}
  | {kind: 'acknowledge'; input: Parameters<Api['acknowledgeMonitorAlert']>[0]};
type Receipt =
  | {kind: 'save' | 'control'; value: ResearchMonitor}
  | {kind: 'check'; value: MonitorCheck}
  | {kind: 'acknowledge'; value: MonitorAlert};
async function execute(client: RocClient, command: Command): Promise<IpcLikeResult<Receipt>> {
  switch (command.kind) {
    case 'save': {
      const result = await client.api.research.saveMonitor(command.input);
      return result.ok ? {ok: true, data: {kind: 'save', value: result.data}} : result;
    }
    case 'control': {
      const result = await client.api.research.controlMonitor(command.input);
      return result.ok ? {ok: true, data: {kind: 'control', value: result.data}} : result;
    }
    case 'check': {
      const result = await client.api.research.checkMonitor(command.input);
      return result.ok ? {ok: true, data: {kind: 'check', value: result.data}} : result;
    }
    case 'acknowledge': {
      const result = await client.api.research.acknowledgeMonitorAlert(command.input);
      return result.ok ? {ok: true, data: {kind: 'acknowledge', value: result.data}} : result;
    }
  }
}
const fieldStyle = 'w-full min-w-0 rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50';
const sources: Array<{id: Extract<MonitorQuery, {kind: 'search'}>['search']['sources'][number]; label: string}> = [
  {id: 'openalex', label: 'OpenAlex'}, {id: 'crossref', label: 'Crossref'}, {id: 'semantic_scholar', label: 'Semantic Scholar'},
  {id: 'arxiv', label: 'arXiv'}, {id: 'pubmed', label: 'PubMed'}, {id: 'europe_pmc', label: 'Europe PMC'}
];
function initialDraft(monitor: ResearchMonitor | null, version: MonitorVersion | null) {
  const query = version?.query;
  return {title: monitor?.title ?? '', cadence: monitor?.cadence ?? 'weekly' as ResearchMonitor['cadence'],
    kind: query?.kind ?? 'search' as MonitorQuery['kind'],
    search: query?.kind === 'search' ? query.search.query : '',
    sources: query?.kind === 'search' ? query.search.sources : ['openalex', 'crossref'] as Extract<MonitorQuery, {kind: 'search'}>['search']['sources'],
    limit: query?.kind === 'search' ? String(query.search.limit) : '10',
    maxPages: query?.kind === 'search' ? String(query.search.maxPages) : '1',
    yearFrom: query?.kind === 'search' && query.search.yearFrom !== undefined ? String(query.search.yearFrom) : '',
    yearTo: query?.kind === 'search' && query.search.yearTo !== undefined ? String(query.search.yearTo) : '',
    target: query?.kind === 'updates' ? query : null as Extract<MonitorQuery, {kind: 'updates'}> | null};
}
export default function MonitorEditor({client, projectId, items, writable, active, monitor, version, onLockChange, onSaved}: {
  client: RocClient; projectId: string; items: ResearchLibraryItem[]; writable: boolean; active: boolean;
  monitor: ResearchMonitor | null; version: MonitorVersion | null; onLockChange: (locked: boolean) => void;
  onSaved: (value: ResearchMonitor) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => initialDraft(monitor, version));
  const [dirty, setDirty] = useState(false);
  const [command, setCommand] = useState<Command | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const mounted = useRef(true), pollCount = useRef(0);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const action = useAsyncAction((value: Command) => execute(client, value), {label: '文献监控操作'});
  const target = useAsyncResource(draft.kind !== 'updates' || draft.target === null ? null :
    JSON.stringify([projectId, draft.target.itemId, items.map(item => [item.id, item.revision, item.archived, item.projectIds])]),
    () => client.api.research.getLibraryItem({id: draft.target!.itemId}), {label: '目标文献'});
  const cancel = useAsyncAction((checkId: string) => client.api.research.cancelMonitorCheck({
    projectId, monitorId: monitor!.id, checkId
  }), {label: '取消文献检查'});
  const live = useAsyncResource(monitor === null ? null : JSON.stringify([projectId, monitor.id, monitor.revision, refresh]),
    () => client.api.research.getMonitorChecks({projectId, monitorId: monitor!.id, offset: 0, limit: 20}), {label: '当前检查'});
  const running = live.data?.records.find(value => value.status === 'running');
  const checking = action.pending && command?.kind === 'check';
  const busy = action.pending || cancel.pending, locked = busy || command !== null || dirty;
  useEffect(() => {onLockChange(locked); return () => onLockChange(false);}, [locked, onLockChange]);
  useEffect(() => {
    if (!active || live.status !== 'ready' || (!checking && running === undefined) || pollCount.current >= 120) return;
    const timer = window.setTimeout(() => {pollCount.current += 1; live.reload();}, 1000);
    return () => window.clearTimeout(timer);
  }, [active, live.status, live.data, live.reload, checking, running]);
  const reload = (): void => {pollCount.current = 0; setRefresh(value => value + 1);};
  const submit = async (value: Command): Promise<void> => {
    setCommand(value); setNote(null); setValidation(null); cancel.reset(); pollCount.current = 0;
    if (value.kind === 'check') live.reload();
    const result = await action.run(value);
    if (!mounted.current || !result.ok) return;
    setCommand(null); setDirty(false); reload();
    if (result.data.kind === 'save' || result.data.kind === 'control') onSaved(result.data.value);
    else if (result.data.kind === 'check') setNote(monitorStatus[result.data.value.status]);
    else setNote('提醒已标为已读');
  };
  const change = (patch: Partial<typeof draft>): void => {setDraft(value => ({...value, ...patch})); setDirty(true); setValidation(null);};
  const save = (): void => {
    const query = draft.kind === 'updates' ? draft.target : {kind: 'search', search: {
      query: draft.search, sources: draft.sources, limit: Number(draft.limit), maxPages: Number(draft.maxPages),
      ...(draft.yearFrom === '' ? {} : {yearFrom: Number(draft.yearFrom)}),
      ...(draft.yearTo === '' ? {} : {yearTo: Number(draft.yearTo)})
    }};
    const parsed = monitorSaveSchema.safeParse({projectId, requestId: crypto.randomUUID(),
      monitorId: monitor?.id ?? null, expectedRevision: monitor?.revision ?? 0, title: draft.title, cadence: draft.cadence, query});
    if (!parsed.success) {setValidation('填写名称及查询；选择至少一个来源，检查结果上限、页数和年份，或选择项目内 DOI 文献。'); return;}
    void submit({kind: 'save', input: parsed.data});
  };
  const stop = async (): Promise<void> => {
    const result = await cancel.run(running!.id);
    if (!mounted.current || !result.ok) return;
    setNote(result.data.cancelled ? '主进程已接收取消信号；等待检查终态。' : '没有对应的进行中检查，请刷新状态。');
    reload();
  };
  const eligible = items.filter(item => !item.archived && item.projectIds.includes(projectId) && item.metadata.doi !== null);
  const targetCurrent = draft.kind !== 'updates' || draft.target === null || (target.status === 'ready' && target.data !== null &&
    !target.data.archived && target.data.projectIds.includes(projectId) && target.data.revision === draft.target.itemRevision);
  const targetChanged = draft.target !== null && target.status === 'ready' && !targetCurrent;
  const editable = writable && !busy && command === null;
  return <div className="space-y-3" data-testid="literature-monitor-editor">
    {monitor === null ? <p className="font-medium">新建文献监控</p> : <dl className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
      <dt>状态</dt><dd>{monitor.status === 'active' ? '已启用' : '已暂停'}</dd>
      <dt>查询版本</dt><dd>{monitor.queryVersion}</dd><dt>控制版本</dt><dd>{monitor.revision}</dd>
      <dt>下次检查</dt><dd>{monitor.nextCheckAt}</dd>
    </dl>}
    {monitor?.lastError === null || monitor === null ? null : <p role="alert" className="break-all">{monitor.lastError}</p>}
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(100px,auto)] gap-2">
      <label>监控名称<input className={fieldStyle} aria-label="监控名称" value={draft.title} maxLength={200} disabled={!editable}
        onChange={event => change({title: event.target.value})}/></label>
      <label>检查频率<select className={fieldStyle} value={draft.cadence} disabled={!editable}
        onChange={event => change({cadence: event.target.value as ResearchMonitor['cadence']})}>
        <option value="daily">每日</option><option value="weekly">每周</option>
      </select></label>
    </div>
    <label className="block">监控类型<select className={fieldStyle} value={draft.kind} disabled={!editable}
      onChange={event => change({kind: event.target.value as MonitorQuery['kind']})}>
      <option value="search">新论文检索</option><option value="updates">文献撤稿与勘误</option>
    </select></label>
    {draft.kind === 'search' ? <>
      <label className="block">检索式<input className={fieldStyle} value={draft.search} maxLength={1000} disabled={!editable}
        onChange={event => change({search: event.target.value})}/></label>
      <fieldset disabled={!editable}><legend>检索来源</legend><div className="flex flex-wrap gap-x-4 gap-y-2 py-1">
        {sources.map(source => <label key={source.id} className="flex items-center gap-1"><input type="checkbox"
          checked={draft.sources.includes(source.id)} onChange={event => change({
            sources: event.target.checked ? [...draft.sources, source.id] : draft.sources.filter(value => value !== source.id)
          })}/>{source.label}</label>)}
      </div></fieldset>
      <details><summary className="cursor-pointer text-muted">检索范围</summary><div className="grid grid-cols-2 gap-2 py-2">
        <label>每来源结果上限<input className={fieldStyle} type="number" min={1} max={30} value={draft.limit} disabled={!editable} onChange={event => change({limit: event.target.value})}/></label>
        <label>每来源页数<input className={fieldStyle} type="number" min={1} max={3} value={draft.maxPages} disabled={!editable} onChange={event => change({maxPages: event.target.value})}/></label>
        <label>起始年份<input className={fieldStyle} type="number" min={1000} max={9999} value={draft.yearFrom} disabled={!editable} onChange={event => change({yearFrom: event.target.value})}/></label>
        <label>截止年份<input className={fieldStyle} type="number" min={1000} max={9999} value={draft.yearTo} disabled={!editable} onChange={event => change({yearTo: event.target.value})}/></label>
      </div></details>
      {monitor === null ? <p className="text-muted">首次成功检索建立基线；后续发现新论文时提醒。</p> : null}
    </> : <>
      <label className="block">目标文献<select className={fieldStyle} value={draft.target === null ? '' : `${draft.target.itemId}:${draft.target.itemRevision}`} disabled={!editable}
        onChange={event => {
          const item = eligible.find(value => `${value.id}:${value.revision}` === event.target.value);
          change({target: item === undefined ? null : {kind: 'updates', itemId: item.id, itemRevision: item.revision, doi: item.metadata.doi!}});
        }}><option value="">选择项目内 DOI 文献</option>
        {draft.target !== null && !eligible.some(item => item.id === draft.target!.itemId && item.revision === draft.target!.itemRevision) ?
          <option value={`${draft.target.itemId}:${draft.target.itemRevision}`}>已绑定目标 / {draft.target.doi}</option> : null}
        {eligible.map(item => <option key={item.id} value={`${item.id}:${item.revision}`}>{item.metadata.title} / {item.metadata.doi}</option>)}
      </select></label>
      {draft.target === null ? null : <p className="break-all text-muted">{draft.target.doi} / 文献版本 {draft.target.itemRevision}</p>}
      <MonitorReadState resource={target} label="目标文献"/>
      {targetChanged ? <p role="alert">目标文献已变化；重新选择后保存新的查询版本。</p> : null}
    </>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={monitorButton} disabled={!editable || !targetCurrent || (monitor !== null && !dirty)} onClick={save}>
        {action.pending && command?.kind === 'save' ? '保存监控中' : '保存查询版本'}</button>
      {!busy && (dirty || command !== null) ? <button type="button" className={monitorButton} onClick={() => {
        setDraft(initialDraft(monitor, version)); setDirty(false); setCommand(null); action.reset(); cancel.reset(); setValidation(null); setNote(null); reload();
      }}>放弃监控修改</button> : null}
      {!busy && command !== null ? <button type="button" className={monitorButton} disabled={!writable} onClick={() => void submit(command)}>重试原监控请求</button> : null}
      {monitor === null ? null : <>
        <button type="button" className={monitorButton} disabled={!writable || locked} onClick={() => void submit({kind: 'control', input: {
          projectId, monitorId: monitor.id, expectedRevision: monitor.revision, requestId: crypto.randomUUID(),
          action: monitor.status === 'active' ? 'pause' : 'resume'
        }})}>{monitor.status === 'active' ? '暂停监控' : '恢复监控'}</button>
        <button type="button" className={monitorButton} disabled={!writable || locked || running !== undefined || !targetCurrent}
          onClick={() => void submit({kind: 'check', input: {projectId, monitorId: monitor.id,
            expectedRevision: monitor.revision, requestId: crypto.randomUUID()}})}>立即检查</button>
        <button type="button" className={monitorButton} onClick={reload}>刷新检查与提醒</button>
        {running === undefined ? null : <button type="button" className={monitorButton} disabled={!writable || cancel.pending}
          onClick={() => void stop()}>取消当前检查</button>}
      </>}
    </div>
    {validation === null ? null : <p role="alert">{validation}</p>}
    {action.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{action.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{cancel.error}</p>}
    {note === null ? null : <p role="status">{note}</p>}
    <MonitorReadState resource={live} label="当前检查"/>
    {running === undefined ? null : <p role="status" className="break-all">检查中 / {running.id}</p>}
    {pollCount.current >= 120 && running !== undefined ? <p className="text-muted">自动刷新已停止，请手动刷新检查状态。</p> : null}
    {monitor === null ? null : <MonitorHistory client={client} projectId={projectId} monitorId={monitor.id}
      queryVersion={monitor.queryVersion} refresh={refresh} locked={locked} writable={writable}
      onAcknowledge={value => void submit({kind: 'acknowledge', input: {projectId, monitorId: monitor.id, alertId: value.id, expectedRevision: 0}})}/>}
  </div>;
}
