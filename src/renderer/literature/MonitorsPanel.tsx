import {useCallback, useEffect, useState} from 'react';
import type {ResearchLibraryItem} from '../../shared/types';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import MonitorEditor from './MonitorEditor';
import {monitorButton, MonitorReadState, MonitorPager} from './MonitorHistory';

export default function MonitorsPanel({client, projectId, items, writable, active, onLockChange}: {
  client: RocClient; projectId: string; items: ResearchLibraryItem[]; writable: boolean; active: boolean;
  onLockChange: (locked: boolean) => void;
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [locked, setLocked] = useState(false);
  const lock = useCallback((value: boolean) => {setLocked(value); onLockChange(value);}, [onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);
  const list = useAsyncResource(JSON.stringify([projectId, offset]),
    () => client.api.research.getMonitors({projectId, offset, limit: 20}), {label: '读取监控列表'});
  const monitor = useAsyncResource(selected === null ? null : JSON.stringify([projectId, selected]),
    () => client.api.research.getMonitor({projectId, monitorId: selected!}), {label: '读取监控'});
  const versions = useAsyncResource(selected === null ? null : JSON.stringify([projectId, selected]),
    () => client.api.research.getMonitorVersions({projectId, monitorId: selected!, offset: 0, limit: 20}), {label: '读取当前查询'});
  const currentVersion = versions.data?.records.find(value => value.version === monitor.data?.queryVersion);
  const refresh = (): void => {list.reload(); monitor.reload(); versions.reload();};
  return <section aria-label="文献监控" data-testid="literature-monitors" className="min-h-0 flex-1 overflow-y-auto p-3 text-[var(--font-body-size)]">
    <div className="flex flex-wrap items-center gap-2">
      <button className={monitorButton} type="button" disabled={!writable || locked}
        onClick={() => {setSelected(null); setCreating(true);}}>新建监控</button>
      <button className={monitorButton} type="button" disabled={locked} onClick={refresh}>刷新监控</button>
      {!writable ? <span className="text-muted">项目只读</span> : null}
    </div>
    <details open data-testid="literature-monitor-list" className="my-3">
      <summary className="cursor-pointer text-muted">监控列表{list.data === null ? '' : `（${list.data.total}）`}</summary>
      <MonitorReadState resource={list} label="监控列表"/>
      {list.data === null ? null : <>
        {list.data.records.length === 0 ? <p className="py-2 text-muted">尚无文献监控</p> :
          <ul className="divide-y divide-line">
            {list.data.records.map(value => <li key={value.id}><button type="button" className={`${monitorButton} my-1 max-w-full text-left`}
              disabled={locked} aria-pressed={selected === value.id} onClick={() => {setCreating(false); setSelected(value.id);}}>
              <span className="break-words">{value.title}</span><span>{value.status === 'active' ? '已启用' : '已暂停'}</span>
              <span>查询版本 {value.queryVersion}</span><span>{value.cadence === 'daily' ? '每日' : '每周'}</span>
            </button></li>)}
          </ul>}
        <MonitorPager label="监控列表" offset={offset} nextOffset={list.data.nextOffset} setOffset={setOffset} disabled={locked || list.status === 'loading'}/>
      </>}
    </details>
    {creating ? <MonitorEditor key="new" client={client} projectId={projectId} items={items} writable={writable}
      active={active} monitor={null} version={null} onLockChange={lock}
      onSaved={value => {setCreating(false); setSelected(value.id); refresh();}}/> : null}
    {selected === null ? null : <>
      <MonitorReadState resource={monitor} label="监控"/>
      <MonitorReadState resource={versions} label="当前查询"/>
      {monitor.status === 'ready' && versions.status === 'ready' && currentVersion === undefined ?
        <p role="alert">查询版本已变化，请刷新监控。</p> : null}
      {monitor.data === null || currentVersion === undefined ? null :
        <MonitorEditor key={`${projectId}:${monitor.data.id}:${monitor.data.revision}:${monitor.data.queryVersion}`}
          client={client} projectId={projectId} items={items} writable={writable} active={active}
          monitor={monitor.data} version={currentVersion} onLockChange={lock} onSaved={refresh}/>}
    </>}
  </section>;
}
