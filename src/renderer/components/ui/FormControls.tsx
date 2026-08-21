import { forwardRef } from 'react';
import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from 'react';

function classNames(base: string, className: string | undefined): string {
  return className === undefined || className.length === 0 ? base : `${base} ${className}`;
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input className={classNames('ui-input', className)} {...props} />;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...props }, ref): React.JSX.Element {
  return <textarea className={classNames('ui-textarea', className)} ref={ref} {...props} />;
});

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select className={classNames('ui-select', className)} {...props} />;
}

export function Checkbox({
  children,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { children: React.ReactNode }): React.JSX.Element {
  return (
    <label className={classNames('ui-checkbox', className)}>
      <input type="checkbox" {...props} />
      <span className="ui-checkbox__box" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

export function CheckboxInput(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <>
      <input {...props} type="checkbox" />
      <span className="ui-checkbox__box" aria-hidden="true" />
    </>
  );
}

export function Radio({
  children,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { children: React.ReactNode }): React.JSX.Element {
  return (
    <label className={classNames('ui-radio', className)}>
      <input type="radio" {...props} />
      <span className="ui-radio__dot" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

export function Switch({
  className,
  label,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string }): React.JSX.Element {
  return (
    <label className={classNames('ui-switch', className)}>
      <input aria-label={label} type="checkbox" {...props} />
      <span className="ui-switch__track" aria-hidden="true"><span className="ui-switch__thumb" /></span>
    </label>
  );
}

export function SwitchInput(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <>
      <input {...props} type="checkbox" />
      <span className="ui-switch__track" aria-hidden="true"><span className="ui-switch__thumb" /></span>
    </>
  );
}
