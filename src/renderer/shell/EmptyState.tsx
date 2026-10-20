import { AlertTriangle, Loader2, type LucideIcon } from 'lucide-react';

/**
 * The one empty/loading/error surface.
 *
 * Shape is fixed: icon + one-line title + optional one sentence + at most one
 * action. No illustrations, no multi-paragraph explanations, and **no
 * placeholder data** — a derived view with no data must look empty, not
 * populated (R12).
 *
 * Tone never relies on color alone: loading gets a spinner, error gets a
 * triangle, empty gets the caller's own icon.
 */

export type EmptyStateTone = 'empty' | 'loading' | 'error';

export type EmptyStateProps = {
  tone?: EmptyStateTone;
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** Secondary escape hatch, e.g. "打开设置" for a blocked state. */
  secondaryAction?: { label: string; onClick: () => void };
  compact?: boolean;
  testId?: string;
};

export function EmptyState({
  tone = 'empty',
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
  testId
}: EmptyStateProps): React.JSX.Element {
  const fallbackIcon = tone === 'loading' ? Loader2 : tone === 'error' ? AlertTriangle : undefined;
  const ResolvedIcon = Icon ?? fallbackIcon;

  return (
    <div
      className={
        compact
          ? 'flex flex-col items-start gap-1 px-3 py-6'
          : 'flex h-full w-full flex-col items-center justify-center gap-2 px-6 py-10 text-center'
      }
      data-testid={testId}
      data-tone={tone}
      role={tone === 'error' ? 'alert' : tone === 'loading' ? 'status' : undefined}
    >
      {ResolvedIcon === undefined ? null : (
        <ResolvedIcon
          size={compact ? 14 : 20}
          aria-hidden="true"
          className={
            tone === 'error'
              ? 'text-[var(--st-bad)]'
              : tone === 'loading'
                ? 'animate-spin text-muted'
                : 'text-subtle'
          }
        />
      )}
      <p className={compact ? 'text-muted' : 'text-ink'}>{title}</p>
      {description === undefined ? null : (
        <p className="max-w-[52ch] text-muted text-[var(--font-meta-size)]">{description}</p>
      )}
      {action === undefined && secondaryAction === undefined ? null : (
        <div className="mt-1 flex items-center gap-2">
          {action === undefined ? null : (
            <button
              type="button"
              onClick={action.onClick}
              disabled={action.disabled ?? false}
              aria-disabled={action.disabled ?? false}
              className="h-[var(--control-height)] rounded-control border border-line bg-surface-strong px-3 text-ink hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50"
            >
              {action.label}
            </button>
          )}
          {secondaryAction === undefined ? null : (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="h-[var(--control-height)] rounded-control px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
