import { CircleAlert, RefreshCw, type LucideIcon } from 'lucide-react';

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
  const Icon = icon ?? (tone === 'loading' ? RefreshCw : CircleAlert);
  const classes = ['empty-state', `empty-state--${tone}`, className]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  return (
    <div className={classes} data-testid={testId}>
      <span className="empty-state-icon">
        <Icon size={24} />
      </span>
      <strong>{title}</strong>
      {detail === undefined ? null : <p>{detail}</p>}
      {action}
    </div>
  );
}
