import type { ReactNode } from 'react';

type ActivityBlockHeaderProps = {
  title: string;
  status?: string;
  actions?: ReactNode;
  className?: string;
  titleClassName?: string;
  statusClassName?: string;
  actionsClassName?: string;
};

export function ActivityBlockHeader({
  title,
  status,
  actions,
  className = 'activity-block-header',
  titleClassName = 'activity-block-title',
  statusClassName = 'activity-block-status',
  actionsClassName = 'activity-block-actions'
}: ActivityBlockHeaderProps): React.JSX.Element {
  return (
    <summary className={className}>
      <span className={titleClassName}>{title}</span>
      {status === undefined ? null : <span className={statusClassName}>{status}</span>}
      {actions === undefined ? null : <span className={actionsClassName}>{actions}</span>}
    </summary>
  );
}
