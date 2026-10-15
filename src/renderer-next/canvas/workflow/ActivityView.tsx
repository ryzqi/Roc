import { AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ResearchStageRun } from '../../../shared/types';
import { EmptyState } from '../../shell/EmptyState';
import { ErrorBar } from '../../shell/ErrorBar';
import { formatBeijingDateTime } from '../../shared/format';
import { eventTone, researchStageLabels } from './format';
import { useWorkflow } from './workflow-scope';
import { StageRunPanel } from './StageRunPanel';

/**
 * 活动流 (P6/T6.9).
 *
 * Two real sources, kept visibly separate because they answer different questions:
 *
 *   - `research.workflow.events` — the persisted workflow log ("what happened to this
 *     project": stage started, role queued, approval requested, stage completed). Three
 *     columns as the plan asks: 标记 · 摘要 · 时间.
 *   - `research.workflow.listRuns` — the stage-run records (status, role, model, retry
 *     chain, error). Rendered with the same `StageRunPanel` the stage workspace uses, so the
 *     two surfaces cannot drift.
 *
 * The filters are additive and never invent data: a filter with no matches shows its own
 * empty line rather than an empty page, so "nothing matched" is distinguishable from
 * "nothing happened".
 *
 * A `failed` stage run's reason is shown through `explainRunError`, which keeps the raw
 * marker visible — the P5 lesson that a generic sentence hides the evidence.
 */

type ActivityFilter = 'all' | 'running' | 'failed' | 'gates';

const FILTER_LABELS: Record<ActivityFilter, string> = {
  all: '全部',
  running: '运行中',
  failed: '失败',
  gates: '审批'
};

export function ActivityView(): React.JSX.Element {
  const store = useWorkflow();
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const { workflow, events, runs } = store;

  const visibleEvents = useMemo(() => events.filter((event) => matchEvent(event.type, filter)), [events, filter]);
  const visibleRuns = useMemo(() => runs.filter((run) => matchRun(run.status, filter)), [runs, filter]);
  const latestRunId = runs.find((run) => run.parentRunId === null)?.id ?? null;

  if (store.status === 'error') {
    return (
      <div className="flex h-full flex-col gap-2 p-4" data-testid="workflow-activity-error">
        <ErrorBar
          error={{
            level: 'page',
            message: store.error ?? '读取流程活动失败',
            retry: store.refresh,
            actionLabel: '重试读取 research.workflow.events'
          }}
        />
      </div>
    );
  }
  if (workflow === null) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="workflow-activity-loading">
        <EmptyState tone="loading" title="正在读取流程活动" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4" data-testid="workflow-activity-view">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-ink text-[var(--font-h2-size)]">活动流</h1>
        <span className="text-subtle text-[var(--font-meta-size)]">
          {researchStageLabels[workflow.currentStage]} · 共 {events.length} 条事件 / {runs.length} 次阶段运行
        </span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="活动过滤">
          {(Object.keys(FILTER_LABELS) as ActivityFilter[]).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={filter === item}
              data-testid={`workflow-activity-filter-${item}`}
              onClick={() => setFilter(item)}
              className={[
                'h-[var(--control-height-compact)] rounded-control border px-2 text-[var(--font-meta-size)]',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                filter === item
                  ? 'border-line-strong bg-surface text-ink'
                  : 'border-transparent text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
              ].join(' ')}
            >
              {FILTER_LABELS[item]}
            </button>
          ))}
        </div>
      </header>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-subtle text-[var(--font-micro-size)]">阶段运行（research.workflow.listRuns）</h2>
        {visibleRuns.length === 0 ? (
          <p className="text-muted text-[var(--font-meta-size)]" role="status" data-testid="workflow-activity-runs-empty">
            没有匹配的阶段运行。
          </p>
        ) : (
          <StageRunPanel
            runs={visibleRuns}
            testId="workflow-activity-runs"
            // The run history is where a *specific* run is inspected, so this is the surface where
            // 「取消运行」/「用同一阶段指令重试」 belong. 总览's strip still owns the stage's *next*
            // action; these two act on the row you are looking at, and they go through the same
            // `runAction` so there is one writer for the workflow state.
            busy={store.busy}
            highlightRunId={latestRunId}
            onCancel={(run) => void store.runAction({ type: 'cancel', runId: run.id })}
            onRetry={(run) => void store.runAction({ type: 'retry', runId: run.id })}
          />
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-subtle text-[var(--font-micro-size)]">工作流事件（research.workflow.events）</h2>
        {visibleEvents.length === 0 ? (
          <p className="text-muted text-[var(--font-meta-size)]" role="status" data-testid="workflow-activity-events-empty">
            没有匹配的事件。
          </p>
        ) : (
          <table className="w-full border-collapse text-left" data-testid="workflow-activity-events">
            <caption className="sr-only">流程事件：标记、摘要与时间</caption>
            <thead>
              <tr className="text-subtle text-[var(--font-micro-size)]">
                <th scope="col" className="w-[150px] pb-1 font-normal">
                  标记
                </th>
                <th scope="col" className="pb-1 font-normal">
                  摘要
                </th>
                <th scope="col" className="w-[150px] pb-1 font-normal">
                  时间
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((event) => (
                <tr key={event.id} className="border-t border-line align-top" data-testid={`workflow-activity-event-${event.id}`}>
                  <td className="py-1 text-[var(--font-meta-size)]">
                    <span className="flex items-center gap-1.5">
                      <EventMark tone={eventTone(event.type)} />
                      <span className="min-w-0">
                        <span className="block truncate text-ink" title={event.type}>
                          {event.type}
                        </span>
                        <span className="block text-subtle text-[var(--font-micro-size)]">
                          {researchStageLabels[event.stage]}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="py-1 text-[var(--font-meta-size)] text-muted">{event.message}</td>
                  <td className="py-1 text-subtle text-[var(--font-micro-size)]">
                    <time dateTime={event.createdAt}>{formatBeijingDateTime(event.createdAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-subtle text-[var(--font-micro-size)]">
        阶段运行没有实时事件通道（后端任务单 B11），这里显示的是每次运行落库后的记录；运行中的阶段由总览与阶段工作区轮询。
      </p>
    </div>
  );
}

function matchEvent(type: string, filter: ActivityFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'running') {
    return type.includes('started') || type.includes('running') || type.includes('queued');
  }
  if (filter === 'failed') {
    return type.includes('failed') || type.includes('rejected') || type.includes('cancelled');
  }
  return type.includes('approval') || type.includes('gate');
}

function matchRun(status: ResearchStageRun['status'], filter: ActivityFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'running') {
    return status === 'queued' || status === 'running';
  }
  if (filter === 'failed') {
    return status === 'failed' || status === 'cancelled' || status === 'interrupted';
  }
  return false;
}

/** Never colour alone (AGENTS.md): every tone also picks a distinct glyph. */
function EventMark({ tone }: { tone: 'info' | 'warn' | 'good' }): React.JSX.Element {
  if (tone === 'good') {
    return <CheckCircle2 size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-ok)]" />;
  }
  if (tone === 'warn') {
    return <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-warn)]" />;
  }
  return <CircleDashed size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-info)]" />;
}
