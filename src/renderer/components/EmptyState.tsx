import { CircleAlert, Inbox, RefreshCw, type LucideIcon } from 'lucide-react';

export function loadFailureDetail(error: string | null): string {
  const reason = error?.trim() ?? '';
  if (reason.length === 0) {
    return '重新打开这一页后再试。';
  }
  const text = /[。！？.!?]$/.test(reason) ? reason : `${reason}。`;
  return `${text}重新打开这一页后再试。`;
}

export function EmptyState({
  action,
  className,
  detail,
  icon,
  title,
  testId,
  tone = 'idle'
}: {
  action?: React.ReactNode;
  className?: string;
  detail?: string;
  icon?: LucideIcon;
  title: string;
  testId: string;
  tone?: 'idle' | 'loading' | 'error';
}): React.JSX.Element {
  const Icon = icon ?? (tone === 'loading' ? RefreshCw : tone === 'error' ? CircleAlert : Inbox);
  const classes = ['empty-state', `empty-state--${tone}`, className]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  return (
    <div
      aria-busy={tone === 'loading' ? true : undefined}
      className={classes}
      data-testid={testId}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="empty-state-icon">
        <Icon aria-hidden="true" size={24} strokeWidth={1.8} />
      </span>
      <strong>{title}</strong>
      {detail === undefined ? null : <p>{detail}</p>}
      {action}
    </div>
  );
}
