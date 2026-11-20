import {ArrowUpRight, Loader2, RefreshCw} from 'lucide-react';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {formatBeijingDateTime} from '../shared/format';
import {TASK_CENTER_GROUPS, TASK_CENTER_SOURCE_LABELS, type TaskCenter, type TaskCenterRow} from './use-task-center';

export function TaskCenterOverview({center, onOpen, disabled = false, testIdPrefix = 'mgmt'}: {
  center: TaskCenter; onOpen: (row: TaskCenterRow) => void; disabled?: boolean; testIdPrefix?: 'mgmt' | 'canvas';
}): React.JSX.Element {
  return <section className="task-center" data-testid={`${testIdPrefix}-task-center`} aria-label="任务总览">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium text-ink">任务总览</h3>
      <button type="button" className={`${formSecondaryButtonClass} inline-flex items-center gap-1`} disabled={center.loading}
        data-testid={`${testIdPrefix}-task-center-refresh`} onClick={center.reload}>
        {center.loading ? <Loader2 size={13} className="animate-spin" aria-hidden="true"/> : <RefreshCw size={13} aria-hidden="true"/>}刷新
      </button>
    </header>
    <div className="task-center-sources" aria-label="任务来源">
      {center.sources.map(source => <div key={source.id} className="flex flex-wrap items-center gap-2" data-testid={`${testIdPrefix}-task-source-${source.id}`}>
        <span>{source.label}</span>
        {source.status === 'error' ? <>
          <span role="alert" className="break-words text-[var(--st-bad)]">{source.error}</span>
          <button type="button" className={formSecondaryButtonClass} onClick={source.reload}>重试</button>
        </> : source.status === 'idle' ? <span>绑定工作区后显示</span> : source.status === 'loading' && source.loaded === 0 ? <span role="status">读取中…</span> :
          <span className="tabular-nums">{source.hasMore ? `近期 ${source.loaded} 项` : `${source.loaded} 项`}{source.hasMore && source.total !== null ? ` / 共 ${source.total} 项` : ''}</span>}
      </div>)}
    </div>
    {TASK_CENTER_GROUPS.map(group => {
      const rows = center.rows.filter(row => row.group === group.id);
      return <section key={group.id} className="task-center-group" aria-label={group.label} data-testid={`${testIdPrefix}-task-group-${group.id}`}>
        <h4 className="flex items-center gap-2 text-ink"><span>{group.label}</span><span className="text-muted tabular-nums">{center.partial ? '已加载 ' : ''}{rows.length} 项</span></h4>
        {rows.length === 0 ? <p className="task-center-empty">{center.loading ? '正在读取任务…' : center.partial ? '已加载范围内暂无任务' : '暂无任务'}</p> :
          <ul className="task-center-list">{rows.map(row => <li key={row.key}>
            <button type="button" className="task-center-row" data-testid={`${testIdPrefix}-task-open-${row.key}`} disabled={disabled} onClick={() => onOpen(row)}>
              <span className="task-center-row-title"><span className="min-w-0 break-words text-ink">{row.title}</span><ArrowUpRight size={13} className="shrink-0 text-subtle" aria-hidden="true"/></span>
              <span className="task-center-row-meta"><span>{TASK_CENTER_SOURCE_LABELS[row.source]}</span><span>{row.status}</span><time dateTime={row.updatedAt} className="tabular-nums">{formatBeijingDateTime(row.updatedAt)}</time></span>
            </button>
          </li>)}</ul>}
      </section>;
    })}
  </section>;
}
