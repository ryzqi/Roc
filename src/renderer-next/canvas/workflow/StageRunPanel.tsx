import { Ban, Clock, Loader2, RefreshCw } from 'lucide-react';
import type { ResearchStageRun } from '../../../shared/types';
import { formatBeijingDateTime } from '../../shared/format';
import { explainRunError, researchRunStatusLabels, researchStageLabels } from './format';

/**
 * Stage-run display (P6/T6.4), shared by 阶段工作区 and 活动流.
 *
 * **What a stage run actually exposes, and what it does not.** The plan says the run
 * display is shared with the assistant and that "run 事件投影复用 P4 的富块". The first
 * half is what this component is. The second half cannot be built from the contract:
 * `chat.onRunEvent` only carries chat/task runs, and `research.workflow.*` has no event
 * channel at all (B11) — a stage run's observable surface is its **record**
 * (`researchStageRunSchema`: status, role, provider/model, attempt/retry link, error,
 * timestamps, input/output artifact ids) plus the project's workflow events. So the panel
 * renders exactly that and says where it came from, rather than projecting rich blocks
 * that do not exist for this run kind. Registered in the phase's deviation table.
 *
 * The **retry chain** is shown explicitly (`retryOfRunId` / `revisionRound`): "same
 * instruction, second attempt" is the product promise of gate 2, so it must be visible
 * rather than inferred from two similar rows.
 */

export type StageRunPanelProps = {
  runs: readonly ResearchStageRun[];
  /** Newest first is the caller's order; this only renders. */
  artifactTitles?: ReadonlyMap<string, string>;
  /** Which run to highlight, e.g. the one the page's action refers to. */
  highlightRunId?: string | null;
  onRetry?: (run: ResearchStageRun) => void;
  onCancel?: (run: ResearchStageRun) => void;
  busy?: boolean;
  testId?: string;
};

export function StageRunPanel({
  runs,
  artifactTitles,
  highlightRunId = null,
  onRetry,
  onCancel,
  busy = false,
  testId = 'workflow-run-panel'
}: StageRunPanelProps): React.JSX.Element {
  if (runs.length === 0) {
    return (
      <section className="rounded-card border border-line bg-surface px-3 py-2.5" data-testid={testId}>
        <p className="text-muted text-[var(--font-meta-size)]" role="status">
          还没有阶段运行记录。
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          artifactTitles={artifactTitles}
          highlighted={run.id === highlightRunId}
          onRetry={onRetry}
          onCancel={onCancel}
          busy={busy}
        />
      ))}
    </section>
  );
}

function RunRow({
  run,
  artifactTitles,
  highlighted,
  onRetry,
  onCancel,
  busy
}: {
  run: ResearchStageRun;
  artifactTitles?: ReadonlyMap<string, string>;
  highlighted: boolean;
  onRetry?: (run: ResearchStageRun) => void;
  onCancel?: (run: ResearchStageRun) => void;
  busy: boolean;
}): React.JSX.Element {
  const inFlight = run.status === 'queued' || run.status === 'running';
  const retryable = run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted';
  const outputs = run.outputArtifactIds.map((id) => artifactTitles?.get(id) ?? id);
  return (
    <article
      className={[
        'flex flex-col gap-1 rounded-card border bg-surface px-3 py-2',
        highlighted ? 'border-line-strong' : 'border-line'
      ].join(' ')}
      data-testid={`workflow-run-${run.id}`}
      data-status={run.status}
      data-parent={run.parentRunId === null ? 'true' : 'false'}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-ink text-[var(--font-meta-size)]" data-testid={`workflow-run-status-${run.id}`}>
          {inFlight ? <Loader2 size={11} aria-hidden="true" className="animate-spin text-[var(--st-warn)]" /> : null}
          {run.status === 'failed' ? <Ban size={11} aria-hidden="true" className="text-[var(--st-bad)]" /> : null}
          {researchRunStatusLabels[run.status]}
        </span>
        <span className="text-subtle text-[var(--font-micro-size)]">
          {researchStageLabels[run.stage]} · 角色 {run.role}
        </span>
        {run.parentRunId === null ? null : <span className="text-subtle text-[var(--font-micro-size)]">子运行</span>}
        {run.retryOfRunId === null ? null : (
          <span className="text-subtle text-[var(--font-micro-size)]" data-testid={`workflow-run-retry-of-${run.id}`}>
            第 {run.revisionRound + 1} 次尝试
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-subtle text-[var(--font-micro-size)]">
          <Clock size={10} aria-hidden="true" />
          {formatBeijingDateTime(run.endedAt ?? run.startedAt ?? run.createdAt)}
        </span>
      </header>

      <p className="truncate text-muted text-[var(--font-meta-size)]" title={run.instruction}>
        指令：{run.instruction}
      </p>

      {run.providerId === null || run.modelId === null ? null : (
        <p className="font-mono text-subtle text-[var(--font-micro-size)]">
          {run.providerId}:{run.modelId}
          {run.modelVersion === null ? '' : ` · ${run.modelVersion}`}
        </p>
      )}

      {outputs.length === 0 ? null : (
        <p className="truncate text-subtle text-[var(--font-micro-size)]" title={outputs.join('、')}>
          产物：{outputs.join('、')}
        </p>
      )}

      {run.error === null ? null : (
        <p className="text-[var(--st-bad)] text-[var(--font-meta-size)]" data-testid={`workflow-run-error-${run.id}`}>
          {explainRunError(run.error)}
        </p>
      )}

      {onCancel === undefined && onRetry === undefined ? null : (
        <div className="flex items-center gap-2">
          {inFlight && onCancel !== undefined ? (
            <button
              type="button"
              data-testid={`workflow-run-cancel-${run.id}`}
              disabled={busy}
              onClick={() => onCancel(run)}
              className="h-[var(--control-height-compact)] rounded-control border border-line px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50"
            >
              取消运行
            </button>
          ) : null}
          {retryable && onRetry !== undefined ? (
            <button
              type="button"
              data-testid={`workflow-run-retry-${run.id}`}
              disabled={busy}
              onClick={() => onRetry(run)}
              className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50"
            >
              <RefreshCw size={11} aria-hidden="true" />
              用同一阶段指令重试
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}
