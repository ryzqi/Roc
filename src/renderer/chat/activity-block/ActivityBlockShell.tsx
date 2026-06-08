import type { PropsWithChildren, ReactNode } from 'react';

type ActivityBlockShellProps = PropsWithChildren<{
  className: string;
  dataTestId: string;
  open: boolean;
  header: ReactNode;
  onToggle: (open: boolean) => void;
}>;

export function ActivityBlockShell({
  className,
  dataTestId,
  open,
  header,
  onToggle,
  children
}: ActivityBlockShellProps): React.JSX.Element {
  return (
    <details
      className={className}
      data-testid={dataTestId}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      {header}
      {children}
    </details>
  );
}
