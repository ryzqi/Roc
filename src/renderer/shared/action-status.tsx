import { useEffect, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react';

export type ActionState = 'idle' | 'pending' | 'success' | 'error';

export type ActionStatusProps = ComponentPropsWithRef<'div'> & {
  state: ActionState;
  /** The owning status/alert can announce this content instead. */
  announce?: boolean;
  icon?: ReactNode;
  testId?: string;
};

/** Controlled display: requests, retries, permissions and drafts stay with the caller. */
export function ActionStatus({
  state,
  announce = true,
  icon,
  children,
  className,
  hidden,
  role,
  testId,
  ...props
}: ActionStatusProps): React.JSX.Element | null {
  if (hidden) return null;

  const statusIcon = state === 'pending'
    ? <LoaderCircle size={12} aria-hidden="true" className="mt-0.5 shrink-0 motion-safe:animate-spin" />
    : state === 'success'
      ? <CircleCheck size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-good)]" />
      : state === 'error'
        ? <TriangleAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-bad)]" />
        : null;
  const statusRole = state === 'error' ? 'alert' : state === 'idle' ? undefined : 'status';

  return (
    <div
      data-testid={testId}
      {...props}
      role={role ?? (announce ? statusRole : undefined)}
      data-action-state={state}
      className={`ui-action-status ui-feedback-enter inline-flex min-w-0 items-start gap-1.5${className ? ` ${className}` : ''}`}
    >
      {icon === undefined ? statusIcon : icon}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export const TRANSIENT_SUCCESS_MS = 2400;

export type TransientStatusProps = Omit<ActionStatusProps, 'state'> & {
  /** A real completed operation or receipt identity; null means no completion. */
  completionId: string | number | null;
};

/** Only successful completion expires; errors and unsaved work use ActionStatus. */
export function TransientStatus({ completionId, ...props }: TransientStatusProps): React.JSX.Element | null {
  const [expiredId, setExpiredId] = useState<string | number | null>(null);

  useEffect(() => {
    if (completionId === null) return;
    const handle = window.setTimeout(() => setExpiredId(completionId), TRANSIENT_SUCCESS_MS);
    return () => window.clearTimeout(handle);
  }, [completionId]);

  if (completionId === null || completionId === expiredId) return null;
  return <ActionStatus {...props} state="success" />;
}
