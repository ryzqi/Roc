import { Loader2 } from 'lucide-react';

/**
 * Scaffolding for the 文稿 tab.
 *
 * Salvaged from the deleted production shell (`production/panel-shell.tsx`) with the parts that
 * outlived it: the stage-artifact scaffolding (`IssueList` + the `ProductionIssue` type), the
 * key/value row and the form field classes went with the panels that used them, because the stage
 * surface and its artifact panels were removed to match the reference's IA.
 *
 * Presentation only: no data, no rules, no IPC.
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

export function InlineHint({ text, testId }: { text: string; testId?: string }): React.JSX.Element {
  return (
    <p className="text-muted text-[var(--font-meta-size)]" role="status" data-testid={testId}>
      {text}
    </p>
  );
}

export const primaryButtonClass =
  'h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] hover:bg-[var(--accent-deep)] active:bg-[var(--accent-deep)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
