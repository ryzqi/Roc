import { useMemo, useState } from 'react';

import type { ResearchStageRun, ResearchWorkflowEvent } from '../../../shared/types';
import { formatResearchTime, researchRunStatusLabels, researchStageLabels } from './research-workflow';

export type ResearchActivityFilter = 'all' | 'running' | 'failed' | 'gates';

export function ResearchActivityView({
  events,
  onSelectEvent,
  runs,
  selectedEventId
}: {
  events: ResearchWorkflowEvent[];
  onSelectEvent: (eventId: string) => void;
  runs: ResearchStageRun[];
  selectedEventId: string | null;
}): React.JSX.Element {
  const [filter, setFilter] = useState<ResearchActivityFilter>('all');
  const visibleEvents = useMemo(() => events.filter((entry) => matchEvent(entry, filter)), [events, filter]);
  const visibleRuns = useMemo(() => runs.filter((run) => matchRun(run, filter)), [filter, runs]);
  return (
    <section className="research-activity-view" data-testid="research-activity-view">
      <div className="research-shell-banner-actions" role="tablist" aria-label="活动过滤">
        {(['all', 'running', 'failed', 'gates'] as const).map((item) => (
          <button
            aria-pressed={filter === item}
            className={filter === item ? 'action-button action-button--primary' : 'action-button'}
            data-testid={`research-activity-filter-${item}`}
            key={item}
            type="button"
            onClick={() => setFilter(item)}
          >
            {filterLabel(item)}
          </button>
        ))}
      </div>
      <div className="research-section-label">阶段运行</div>
      {visibleRuns.length === 0 ? <p>没有匹配的运行。</p> : visibleRuns.map((run) => (
        <div className="research-shell-activity-row" data-testid={`research-activity-run-${run.id}`} key={run.id}>
          <strong>{researchStageLabels[run.stage]} · {researchRunStatusLabels[run.status]}</strong>
          <span>{run.role}{run.error === null ? '' : ` · ${run.error}`}</span>
        </div>
      ))}
      <div className="research-section-label">工作流事件</div>
      {visibleEvents.length === 0 ? <p>没有匹配的活动。</p> : visibleEvents.map((entry) => (
        <button
          className={entry.id === selectedEventId ? 'research-overview-event research-overview-event--active' : 'research-overview-event'}
          data-testid={`research-activity-event-${entry.id}`}
          key={entry.id}
          type="button"
          onClick={() => onSelectEvent(entry.id)}
        >
          <strong>{researchStageLabels[entry.stage]}</strong>
          <span>{entry.message}</span>
          <time>{formatResearchTime(entry.createdAt)}</time>
        </button>
      ))}
    </section>
  );
}

function filterLabel(filter: ResearchActivityFilter): string {
  if (filter === 'running') return '运行中';
  if (filter === 'failed') return '失败';
  if (filter === 'gates') return '审批';
  return '全部';
}

function matchEvent(entry: ResearchWorkflowEvent, filter: ResearchActivityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return entry.type.includes('started') || entry.type.includes('running');
  if (filter === 'failed') return entry.type.includes('failed') || entry.type.includes('rejected') || entry.type.includes('cancelled');
  return entry.type.includes('approval') || entry.type.includes('gate');
}

function matchRun(run: ResearchStageRun, filter: ResearchActivityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return run.status === 'queued' || run.status === 'running';
  if (filter === 'failed') return run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted';
  return false;
}
