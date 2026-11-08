export function InlineHint({ text, testId }: { text: string; testId?: string }): React.JSX.Element {
  return (
    <p className="text-muted text-[length:var(--font-meta-size)]" role="status" data-testid={testId}>
      {text}
    </p>
  );
}

export const primaryButtonClass =
  'h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] hover:bg-[var(--accent-deep)] active:bg-[var(--accent-deep)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
