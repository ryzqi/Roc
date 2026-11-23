import {useCallback, useEffect, useRef, useState} from 'react';
import type {ResearchLibraryItem} from '../../shared/types';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import MonitorEditor from './MonitorEditor';
import {monitorButton, MonitorReadState, MonitorPager} from './MonitorHistory';
import {LiteratureEditorBoundary} from './literature-editor-guard';
import {useViewSelected} from '../shared/view-activity';
import {ReadingViewBoundary} from './ReadingViewBoundary';
import './discovery-workspace.css';

type Props = {
  client: RocClient; projectId: string; items: ResearchLibraryItem[]; writable: boolean; active: boolean;
  onLockChange: (locked: boolean) => void;
};
export default function MonitorsPanel(props: Props): React.JSX.Element {
  return <LiteratureEditorBoundary key={props.projectId} projectId={props.projectId}>
    <MonitorsContent {...props}/>
  </LiteratureEditorBoundary>;
}

function MonitorsContent({client, projectId, items, writable, active, onLockChange}: Props): React.JSX.Element {
  const viewSelected = useViewSelected(), readingRoot = useRef<HTMLElement>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [locked, setLocked] = useState(false);
  const lockRef = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {if (selected !== null || creating) detailHeading.current?.focus({preventScroll:true});}, [selected, creating]);
  const lock = useCallback((value: boolean) => {lockRef.current = value; setLocked(value); onLockChange(value);}, [onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);
  const list = useAsyncResource(JSON.stringify([projectId, offset]),
    () => client.api.research.getMonitors({projectId, offset, limit: 20}), {label: '读取监控列表'});
  const monitor = useAsyncResource(selected === null ? null : JSON.stringify([projectId, selected]),
    () => client.api.research.getMonitor({projectId, monitorId: selected!}), {label: '读取监控'});
  const versions = useAsyncResource(selected === null ? null : JSON.stringify([projectId, selected]),
    () => client.api.research.getMonitorVersions({projectId, monitorId: selected!, offset: 0, limit: 20}), {label: '读取当前查询'});
  const currentVersion = versions.data?.records.find(value => value.version === monitor.data?.queryVersion);
  const refresh = (): void => {list.reload(); monitor.reload(); versions.reload();};
  const select = (id: string | null): void => {
    if (lockRef.current) return;
    setSelected(id); setCreating(id === null);
  };
  return <ReadingViewBoundary selected={viewSelected} identity={JSON.stringify([projectId,selected])}
    containerRef={readingRoot} scrollSelectors={['.monitor-detail','.monitor-index']}>
    <section ref={readingRoot} aria-label="文献监控" data-testid="literature-monitors" className="monitor-workspace" data-detail={selected !== null || creating}>
    <header className="monitor-toolbar">
      <div><h2>文献监控</h2></div>
      <button className={monitorButton} type="button" disabled={!writable || locked}
        onClick={() => select(null)}>新建监控</button>
      <button className={monitorButton} type="button" disabled={locked} onClick={() => {if (!lockRef.current) refresh();}}>刷新监控</button>
      {!writable ? <span className="text-muted">项目只读</span> : null}
    </header>
    <div className="monitor-columns">
    <section data-testid="literature-monitor-list" className="monitor-index" aria-label="监控列表">
      <h3 ref={listHeading} tabIndex={-1}>监控列表{list.data === null ? '' : `（${list.data.total}）`}</h3>
      <MonitorReadState resource={list} label="监控列表"/>
      {list.data === null ? null : <>
        {list.data.records.length === 0 ? <p className="py-2 text-muted">尚无文献监控</p> :
          <ul className="divide-y divide-line">
            {list.data.records.map(value => <li key={value.id}><button type="button" className="monitor-index-item"
              disabled={locked} aria-pressed={selected === value.id} onClick={() => select(value.id)}>
              <span className="break-words">{value.title}</span><span>{value.status === 'active' ? '已启用' : '已暂停'}</span>
              <span>查询版本 {value.queryVersion}</span><span>{value.cadence === 'daily' ? '每日' : '每周'}</span>
            </button></li>)}
          </ul>}
        <MonitorPager label="监控列表" offset={offset} nextOffset={list.data.nextOffset} setOffset={setOffset} disabled={locked || list.status === 'loading'}/>
      </>}
    </section>
    <div className="monitor-detail">
      {selected !== null || creating ? <div className="monitor-detail-header">
        <button type="button" className={`${monitorButton} monitor-back`} disabled={locked} onClick={() => {
          if(lockRef.current)return;setSelected(null);setCreating(false);
          requestAnimationFrame(() => listHeading.current?.focus({preventScroll:true}));
        }}>返回监控列表</button>
        <h3 ref={detailHeading} tabIndex={-1}>{creating ? '设置监控' : monitor.data?.title ?? '监控详情'}</h3>
      </div> : <div className="monitor-empty"><h3>选择一项监控</h3></div>}
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
    </div>
    </div>
  </section></ReadingViewBoundary>;
}
