import { Loader2, X } from 'lucide-react';

/**
 * Long-running task surface (R11).
 *
 * Anything that can exceed ~2s (MinerU parse, LaTeX compile, experiment, export,
 * model download, index rebuild) uses this instead of a bare spinner, so the
 * user can see progress and cancel. `onCancel` maps to the operation's own
 * cancel interface — never to a renderer-side abort that leaves the backend
 * running.
 */

export type ProgressTaskProps = {
  label: string;
  /** Provider-reported fraction, 0..1. Omit when the backend has no progress. */
  progress?: number;
  /** Provider-reported phase, e.g. "正在解析公式". */
  detail?: string;
  onCancel?: () => void;
  /** Polling is honest, not real-time (no push channel for most backends). */
  polling?: boolean;
  testId?: string;
};

export function ProgressTask({ label, progress, detail, onCancel, polling = false, testId }: ProgressTaskProps): React.JSX.Element {
  const ratio = progress === undefined ? null : Math.min(Math.max(progress, 0), 1);
  const percent = ratio === null ? null : Math.round(ratio * 100);

  return (
    <div
      className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5"
      data-testid={testId}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Loader2 size={13} aria-hidden="true" className="animate-spin text-muted" />
        <span className="min-w-0 flex-1 truncate text-ink">{label}</span>
        {percent === null ? null : (
          <span className="font-mono text-muted text-[var(--font-meta-size)]" data-testid="progress-task-percent">
            {percent}%
          </span>
        )}
        {onCancel === undefined ? null : (
          <button
            type="button"
            onClick={onCancel}
            aria-label={`取消${label}`}
            className="rounded-control p-1 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>

      <div
        className="h-1 w-full overflow-hidden rounded-full bg-bg-soft"
        role={percent === null ? undefined : 'progressbar'}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent === null ? undefined : percent}
        aria-valuetext={percent === null ? undefined : `${percent}%`}
      >
        {percent === null ? (
          <div className="h-full w-1/4 animate-pulse rounded-full bg-accent-soft-strong" />
        ) : (
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        )}
      </div>

      {detail === undefined && !polling ? null : (
        <p className="text-muted text-[var(--font-micro-size)]">
          {detail ?? ''}
          {detail !== undefined && polling ? ' · ' : ''}
          {polling ? '轮询中' : ''}
        </p>
      )}
    </div>
  );
}
