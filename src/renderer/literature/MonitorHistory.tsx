import {useState} from 'react';
import type {MonitorAlert, MonitorCheck, MonitorQuery, MonitorSource} from '../../shared/schemas/research-monitors';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource, type AsyncResource} from '../app/use-async-resource';

export const monitorButton = 'inline-flex flex-wrap items-center gap-2 rounded-control border-[0.5px] border-line px-2 py-1 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50';
export const monitorStatus = {running: '检查中', complete: '检查完成', partial: '部分完成', failed: '检查失败', cancelled: '已取消', interrupted: '已中断'};
const eventLabels = {new_paper: '新论文', retraction: '撤稿', correction: '勘误', other_update: '其他更新'};
const coverageLabels = {unknown: '覆盖范围未知', limited: '有限覆盖', reported_end: '来源报告结束', failed: '读取失败'};

export function MonitorReadState({resource, label}: {resource: Pick<AsyncResource<unknown>, 'status' | 'error' | 'reload'>; label: string}): React.JSX.Element {
  return <>{resource.status === 'loading' ? <p role="status">读取{label}中</p> : null}
    {resource.error === null ? null : <div role="alert" className="break-words py-1"><p>{resource.error}</p>
      <button type="button" className={monitorButton} onClick={resource.reload}>重试{label}</button></div>}</>;
}
export function MonitorPager({label, offset, nextOffset, setOffset, disabled}: {
  label: string; offset: number; nextOffset: number | null; setOffset: (value: number) => void; disabled: boolean;
}): React.JSX.Element {
  return <div className="flex flex-wrap gap-2 py-2">
    <button type="button" className={monitorButton} disabled={disabled || offset === 0} onClick={() => setOffset(offset - 20)}>{label}上一页</button>
    <button type="button" className={monitorButton} disabled={disabled || nextOffset === null} onClick={() => setOffset(nextOffset!)}>{label}下一页</button>
  </div>;
}
export function MonitorQueryView({query}: {query: MonitorQuery}): React.JSX.Element {
  return query.kind === 'updates' ? <dl className="break-all"><dt>DOI 更新</dt><dd>{query.doi}</dd>
    <dt>文献版本</dt><dd>{query.itemId} / {query.itemRevision}</dd></dl> :
    <dl className="break-words"><dt>查询</dt><dd>{query.search.query}</dd><dt>来源</dt><dd>{query.search.sources.join(', ')}</dd>
      <dt>每来源上限</dt><dd>{query.search.limit} 条 / {query.search.maxPages} 页</dd>
      <dt>年份</dt><dd>{query.search.yearFrom ?? '不限'} 至 {query.search.yearTo ?? '不限'}</dd></dl>;
}
function MonitorRawSource({source}: {source: MonitorSource}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-muted">请求回执与来源快照</summary>
    {open ? <pre className="max-w-full whitespace-pre-wrap break-all py-2 text-[length:var(--font-meta-size)]">{JSON.stringify(source, null, 2)}</pre> : null}
  </details>;
}
export function MonitorCheckView({check}: {check: MonitorCheck}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <details className="py-2" data-testid="literature-monitor-check" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer break-words">{monitorStatus[check.status]} / 查询版本 {check.queryVersion} / {check.startedAt}</summary>
    {open ? <><dl className="break-all space-y-1 py-2"><dt>检查 ID</dt><dd>{check.id}</dd><dt>触发</dt><dd>{check.trigger === 'manual' ? '手动' : '计划'}</dd>
      <dt>结束时间</dt><dd>{check.finishedAt ?? '尚未结束'}</dd><dt>新增提醒</dt><dd>{check.alertCount}</dd>
      <dt>错误</dt><dd>{check.errorCode ?? '无已报告错误'}</dd></dl>
    {check.sources.map(source => <details key={source.source} className="py-1" data-testid="literature-monitor-source">
      <summary className="cursor-pointer">{source.source} / {source.status === 'ok' ? '来源读取完成' : source.status === 'partial' ? '来源部分完成' : '来源读取失败'}</summary>
      <dl className="break-all space-y-1 py-2"><dt>治理状态</dt><dd>{source.governance.state}</dd>
        <dt>剩余请求</dt><dd>{source.governance.remainingRequests}</dd><dt>执行 ID</dt><dd>{source.executionId ?? '无搜索执行'}</dd>
        <dt>获取时间</dt><dd>{source.fetchedAt ?? (source.search === null ? '未获取' : '见逐页请求回执')}</dd><dt>缓存</dt><dd>{source.cache ?? '见逐页回执'}</dd>
        <dt>错误</dt><dd>{source.errorCode ?? '无已报告错误'}</dd><dt>重试等待</dt><dd>{source.retryAfterMs === null ? '未报告' : `${source.retryAfterMs} ms`}</dd>
        <dt>覆盖</dt><dd>{source.material === null ? (source.search === null ? '覆盖范围未知' : '见搜索来源覆盖') : coverageLabels[source.material.coverage]}</dd>
      </dl>
      {source.search?.sources.map(receipt => <div key={receipt.source} className="space-y-1 break-all py-1">
        <p>{receipt.source} / {coverageLabels[receipt.coverage.state]} / 已验证 {receipt.coverage.validatedPages} 页</p>
        <p>命中 {receipt.coverage.apiHitCount ?? '未知'} / 停止原因 {receipt.stopReason}</p>
        {receipt.pages.map((entry, index) => <p key={index}>页 {index + 1} / 缓存 {entry.cache.state}
          {entry.cache.state === 'hit' ? ` / 原获取 ${entry.cache.fetchedAt}` : ''} / {entry.url}</p>)}
      </div>)}
      <MonitorRawSource source={source}/>
    </details>)}</> : null}
  </details>;
}
export default function MonitorHistory({client, projectId, monitorId, queryVersion, refresh, locked, writable, onAcknowledge}: {
  client: RocClient; projectId: string; monitorId: string; queryVersion: number; refresh: number;
  locked: boolean; writable: boolean; onAcknowledge: (value: MonitorAlert) => void;
}): React.JSX.Element {
  const [versionOffset, setVersionOffset] = useState(0), [checkOffset, setCheckOffset] = useState(0), [alertOffset, setAlertOffset] = useState(0);
  const versions = useAsyncResource(JSON.stringify([projectId, monitorId, queryVersion, versionOffset, refresh]),
    () => client.api.research.getMonitorVersions({projectId, monitorId, offset: versionOffset, limit: 20}), {label: '查询版本历史'});
  const checks = useAsyncResource(JSON.stringify([projectId, monitorId, queryVersion, checkOffset, refresh]),
    () => client.api.research.getMonitorChecks({projectId, monitorId, offset: checkOffset, limit: 20}), {label: '检查历史'});
  const alerts = useAsyncResource(JSON.stringify([projectId, monitorId, queryVersion, alertOffset, refresh]),
    () => client.api.research.getMonitorAlerts({projectId, monitorId, offset: alertOffset, limit: 20}), {label: '提醒历史'});
  return <div className="space-y-3 border-t-[0.5px] border-line pt-3">
    <details data-testid="literature-monitor-versions"><summary className="cursor-pointer">查询版本历史</summary>
      <MonitorReadState resource={versions} label="查询版本历史"/>
      {versions.data === null ? null : <><ul>{versions.data.records.map(value => <li key={value.version} className="py-2">
        <p>查询版本 {value.version} / {value.createdAt}</p><MonitorQueryView query={value.query}/></li>)}</ul>
        <MonitorPager label="查询版本" offset={versionOffset} nextOffset={versions.data.nextOffset} setOffset={setVersionOffset} disabled={locked || versions.status === 'loading'}/></>}
    </details>
    <details open data-testid="literature-monitor-checks"><summary className="cursor-pointer">检查历史</summary>
      <MonitorReadState resource={checks} label="检查历史"/>
      {checks.data === null ? null : <>{checks.data.records.length === 0 ? <p className="py-2 text-muted">尚无检查</p> : checks.data.records.map(value => <MonitorCheckView key={value.id} check={value}/>)}
        <MonitorPager label="检查历史" offset={checkOffset} nextOffset={checks.data.nextOffset} setOffset={setCheckOffset} disabled={locked || checks.status === 'loading'}/></>}
    </details>
    <details open data-testid="literature-monitor-alerts"><summary className="cursor-pointer">提醒历史</summary>
      <MonitorReadState resource={alerts} label="提醒历史"/>
      {alerts.data === null ? null : <>{alerts.data.records.length === 0 ? <p className="py-2 text-muted">暂无提醒</p> :
        <ul className="divide-y divide-line">{alerts.data.records.map(value => <li key={value.id} className="space-y-1 py-2" data-testid="literature-monitor-alert">
          <p className="break-words">{eventLabels[value.kind]} / {value.title}</p>
          <p className="break-all text-muted">{value.source} / 查询版本 {value.queryVersion} / {value.observedAt}</p>
          <details><summary className="cursor-pointer text-muted">提醒来源</summary><dl className="break-all">
            <dt>原始字段</dt><dd>{value.field}</dd><dt>来源类型</dt><dd>{value.providerType ?? '未报告'}</dd>
            <dt>目标 DOI</dt><dd>{value.subjectDoi ?? '未报告'}</dd><dt>通知 DOI</dt><dd>{value.noticeDoi ?? '未报告'}</dd>
            <dt>检查 ID</dt><dd>{value.checkId}</dd><dt>来源哈希</dt><dd>{value.sourceHash}</dd></dl></details>
          {value.acknowledgement === null ? <button type="button" className={monitorButton} disabled={!writable || locked}
            onClick={() => onAcknowledge(value)}>标为已读</button> : <p>已读 / {value.acknowledgement.at}</p>}
        </li>)}</ul>}
        <MonitorPager label="提醒历史" offset={alertOffset} nextOffset={alerts.data.nextOffset} setOffset={setAlertOffset} disabled={locked || alerts.status === 'loading'}/></>}
      <p className="py-1 text-muted">已读仅记录阅读状态；提醒不修改已批准结论。</p>
    </details>
  </div>;
}
