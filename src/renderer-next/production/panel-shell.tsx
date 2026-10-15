import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ProductionIssue } from './production-rules';

/**
 * Shared scaffolding for the production panels (P7).
 *
 * Nine panels in one phase would otherwise grow nine slightly different section headers, nine
 * different "why can't I click this" renderings and nine different busy states — the drift the
 * legacy shell accumulated. These are presentation only: no data, no rules, no IPC.
 */

export function PanelSection({
  title,
  hint,
  action,
  children,
  testId
}: {
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean; testId: string };
  children: React.ReactNode;
  testId: string;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5"
      data-testid={testId}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-ink text-[var(--font-h3-size)]">{title}</h3>
        {hint === undefined ? null : <span className="text-subtle text-[var(--font-micro-size)]">{hint}</span>}
        {action === undefined ? null : (
          <button
            type="button"
            data-testid={action.testId}
            disabled={action.disabled === true || action.busy === true}
            onClick={action.onClick}
            className="ml-auto flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-muted text-[var(--font-meta-size)] hover:text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {action.busy === true ? <Loader2 size={11} aria-hidden="true" className="animate-spin" /> : null}
            {action.label}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * The blocking reasons a main action is disabled.
 *
 * Never colour alone: each row carries a warning glyph, and an empty list renders nothing (so
 * "no blockers" is visibly *absent* rather than a reassuring green line).
 */
export function IssueList({ issues, testId }: { issues: readonly ProductionIssue[]; testId: string }): React.JSX.Element | null {
  if (issues.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-0.5" data-testid={testId} role="note">
      {issues.map((issue) => (
        <li key={`${issue.reference ?? 'issue'}:${issue.message}`} className="flex items-start gap-1.5 text-[var(--st-warn)] text-[var(--font-meta-size)]">
          <AlertTriangle size={11} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0">{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function KeyValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex gap-2 text-[var(--font-micro-size)]">
      <dt className="w-[76px] shrink-0 text-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 break-words font-mono text-muted">{value}</dd>
    </div>
  );
}

export function InlineHint({ text, testId }: { text: string; testId?: string }): React.JSX.Element {
  return (
    <p className="text-muted text-[var(--font-meta-size)]" role="status" data-testid={testId}>
      {text}
    </p>
  );
}

export function FieldLabel({ text }: { text: string }): React.JSX.Element {
  return <span className="text-subtle text-[var(--font-micro-size)]">{text}</span>;
}

export const textInputClass =
  'h-[var(--control-height)] w-full rounded-control border border-line bg-bg px-2 text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export const textAreaClass =
  'w-full resize-y rounded-control border border-line bg-bg px-2 py-1 text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export const selectClass =
  'h-[var(--control-height)] w-full rounded-control border border-line bg-bg px-2 text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export const primaryButtonClass =
  'h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] hover:bg-[var(--accent-deep)] active:bg-[var(--accent-deep)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export const secondaryButtonClass =
  'h-[var(--control-height-compact)] rounded-control border border-line px-2 text-muted text-[var(--font-meta-size)] hover:text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
