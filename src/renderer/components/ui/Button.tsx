import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'compact' | 'default';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  className,
  icon,
  size = 'default',
  type = 'button',
  variant = 'secondary',
  ...props
}, ref): React.JSX.Element {
  const classes = ['ui-button', `ui-button--${variant}`, `ui-button--${size}`, className]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  return (
    <button className={classes} ref={ref} type={type} {...props}>
      {icon === undefined ? null : <span className="ui-button__icon" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
});
