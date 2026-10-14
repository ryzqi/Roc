import type { ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

/**
 * Shared shell for the collapsed "activity" blocks (T4.4): tool calls, hooks,
 * subagent cards, guardrails, context compaction, reasoning.
 *
 * The legacy shell had one `ActivityBlockShell` that took a whole `header` node, so
 * every block re-implemented its own icon + label + badge + chevron markup (and they
 * drifted: some had a status pill, some did not). This version owns that row once —
 * icon, title, optional meta, optional status pill, chevron — and the blocks only
 * supply their own body. It also means the states are consistent by construction:
 *
 *   - the pill's colours come from the `--tool-st-*` token group P0 reserved for
 *     exactly these five states, so light/dark follow automatically;
 *   - the state is **never signalled by colour alone**: the pill always carries a
 *     label ("执行中" / "成功" / "错误"…) and the icon differs per state (AGENTS.md).
 *
 * A native `<details>` keeps the disclosure keyboard- and screen-reader-correct; the
 * rotation is driven by the controlled `open` prop (the blocks already own that
 * state through `useActivityBlockState`) rather than by a CSS `[open]` selector, so
 * the visual and the DOM cannot disagree.
 */

export type ActivityTone = 'neutral' | 'start' | 'progress' | 'end' | 'error';

const TONE_PILL: Record<ActivityTone, string> = {
  neutral: 'bg-[var(--overlay-hover)] text-muted',
  start: 'bg-[var(--tool-st-start-bg)] text-[var(--tool-st-start-text)]',
  progress: 'bg-[var(--tool-st-progress-bg)] text-[var(--tool-st-progress-text)]',
  end: 'bg-[var(--tool-st-end-bg)] text-[var(--tool-st-end-text)]',
  error: 'bg-[var(--tool-st-error-bg)] text-[var(--tool-st-error-text)]'
};

const TONE_ICON: Record<ActivityTone, string> = {
  neutral: 'text-subtle',
  start: 'text-[var(--tool-st-start-text)]',
  progress: 'text-[var(--tool-st-progress-text)]',
  end: 'text-[var(--tool-st-end-text)]',
  error: 'text-[var(--tool-st-error-text)]'
};

export type ActivityBlockShellProps = {
  testId: string;
  icon: LucideIcon;
  title: string;
  /** Status word shown in the pill; omit for blocks with no state. */
  statusLabel?: string;
  /** Secondary text (duration, handler id, tool count…) shown after the title. */
  meta?: string;
  tone?: ActivityTone;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** The block has no body at all: no chevron, nothing to open. */
  expandable?: boolean;
  children?: ReactNode;
};

export function ActivityBlockShell({
  testId,
  icon: Icon,
  title,
  statusLabel,
  meta,
  tone = 'neutral',
  open,
  onToggle,
  expandable = true,
  children
}: ActivityBlockShellProps): React.JSX.Element {
  return (
    <details
      className="my-1 rounded-card border border-line bg-surface"
      data-testid={testId}
      data-tone={tone}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary
        className="flex cursor-default list-none items-center gap-2 px-2 py-1.5 [&::-webkit-details-marker]:hidden"
        data-testid={`${testId}-summary`}
      >
        <Icon size={12} aria-hidden="true" strokeWidth={2.5} className={`shrink-0 ${TONE_ICON[tone]}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--font-meta-size)]" title={title}>
          {title}
        </span>
        {meta === undefined ? null : (
          <span className="shrink-0 text-subtle text-[var(--font-micro-size)]">{meta}</span>
        )}
        {statusLabel === undefined ? null : (
          <span className={`shrink-0 rounded-control px-1.5 py-0.5 text-[var(--font-micro-size)] ${TONE_PILL[tone]}`}>
            {statusLabel}
          </span>
        )}
        {expandable ? (
          <ChevronDown
            size={12}
            aria-hidden="true"
            className={
              open
                ? 'shrink-0 rotate-180 text-subtle transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none'
                : 'shrink-0 text-subtle transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none'
            }
          />
        ) : null}
      </summary>
      {children}
    </details>
  );
}

/** Body wrapper: one place decides the indentation and the scroll behaviour. */
export function ActivityBlockBody({
  children,
  testId
}: {
  children: ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <div
      className="min-w-0 border-t border-line-soft px-2 py-1.5 text-[var(--font-meta-size)]"
      data-testid={testId}
    >
      {children}
    </div>
  );
}
