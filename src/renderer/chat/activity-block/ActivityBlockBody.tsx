import type { PropsWithChildren } from 'react';

type ActivityBlockBodyProps = PropsWithChildren<{
  className?: string;
}>;

export function ActivityBlockBody({ children, className = 'activity-block-body' }: ActivityBlockBodyProps): React.JSX.Element {
  return <div className={className}>{children}</div>;
}
