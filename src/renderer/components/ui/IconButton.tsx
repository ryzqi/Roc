import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string;
  children: ReactNode;
  tone?: 'neutral' | 'danger';
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  children,
  className,
  label,
  title = label,
  tone = 'neutral',
  type = 'button',
  ...props
}, ref): React.JSX.Element {
  const classes = ['ui-icon-button', `ui-icon-button--${tone}`, className]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  return (
    <button aria-label={label} className={classes} ref={ref} title={title} type={type} {...props}>
      {children}
    </button>
  );
});
