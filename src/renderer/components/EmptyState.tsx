import { CircleAlert, RefreshCw } from 'lucide-react';

export function EmptyState({
  action,
  title,
  testId,
  tone = 'idle'
}: {
  action?: React.ReactNode;
  title: string;
  testId: string;
  tone?: 'idle' | 'loading' | 'error';
}): React.JSX.Element {
  const Icon = tone === 'loading' ? RefreshCw : CircleAlert;
  return (
    <div className={`empty-state empty-state--${tone}`} data-testid={testId}>
      <span className="empty-state-icon">
        <Icon size={24} />
      </span>
      <strong>{title}</strong>
      {action}
    </div>
  );
}
