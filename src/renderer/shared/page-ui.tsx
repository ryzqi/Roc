import {useId, type ComponentPropsWithRef, type ReactNode} from 'react';

/** Page composition only. Callers own data, navigation and the one primary action. */
export function PageHeader({title, description, status, action, testId}: {
  title: string;
  description?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  testId?: string;
}): React.JSX.Element {
  return <header className="flex min-w-0 flex-wrap items-start justify-between gap-4" data-testid={testId}>
    <div className="grid min-w-0 flex-1 basis-64 gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-2">
        <h1 className="min-w-0 wrap-anywhere text-balance text-[length:var(--font-h1-size)] font-semibold">{title}</h1>
        {status}
      </div>
      {description === undefined ? null : <div className="min-w-0 whitespace-pre-wrap wrap-anywhere text-muted">{description}</div>}
    </div>
    {action === undefined ? null : <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{action}</div>}
  </header>;
}

/** A labelled data region; empty, loading and failure content uses the existing state surfaces. */
export function PageSection({title, action, children, testId, className = ''}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}): React.JSX.Element {
  const headingId = useId();
  return <section aria-labelledby={headingId} data-testid={testId}
    className={`grid min-w-0 content-start gap-3 border-t-[0.5px] border-line pt-4 ${className}`}>
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <h2 id={headingId} className="min-w-0 wrap-anywhere font-medium">{title}</h2>
      {action}
    </header>
    {children}
  </section>;
}

type PageListRowProps = Omit<ComponentPropsWithRef<'button'>, 'title' | 'children'> & {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
};

/** One native action per row. Selection, roving focus and virtualization stay with its list owner. */
export function PageListRow({title, description, leading, trailing, className = '', type = 'button', ...props}: PageListRowProps): React.JSX.Element {
  return <button {...props} type={type}
    className={`flex min-h-12 w-full min-w-0 items-start gap-3 rounded-control px-3 py-3 text-left enabled:hover:bg-[var(--overlay-hover)] enabled:active:bg-[var(--overlay-active)] aria-[current=true]:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${className}`}>
    {leading === undefined ? null : <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted">{leading}</span>}
    <span className="flex min-w-0 flex-1 flex-col gap-1 wrap-anywhere">
      <span className="text-ink">{title}</span>
      {description === undefined ? null : <span className="text-[length:var(--font-meta-size)] text-muted">{description}</span>}
    </span>
    {trailing === undefined ? null : <span className="shrink-0 text-[length:var(--font-meta-size)] text-muted">{trailing}</span>}
  </button>;
}
