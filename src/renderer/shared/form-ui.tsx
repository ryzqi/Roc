import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';

/**
 * Shared form primitives (extracted in P9 from P8's `settings/settings-ui.tsx`).
 *
 * Two features now build real forms — the settings centre's thirteen sections and the
 * management drawer's four — and a third copy of these controls would have drifted the same
 * way the legacy renderer's did. The names are feature-neutral for the same reason: a
 * management-only control must not be called `SettingsNote`.
 *
 * Presentation only: no IPC, no rules, no draft access. The class strings are the same
 * vocabulary the P3–P8 panels use (`--control-height`, `--font-meta-size`, `--overlay-hover`,
 * `focus-visible:outline-accent`).
 *
 * Three accessibility rules are structural, not conventional:
 *
 *  - every control has a visible label bound to it (`<label>` wrapping or `htmlFor`),
 *    so a screen reader announces the field, not just the value;
 *  - a field-level problem renders next to the control with a warning glyph plus the
 *    backend-shaped message (never colour alone);
 *  - a read-only/derived value is marked with a 「只读」 chip, because several
 *    sections report state the backend owns and must not look editable.
 */

export const formInputClass =
  'h-[var(--control-height)] w-full rounded-control border border-line bg-bg px-2 text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
export const formSelectClass = formInputClass;
export const formTextAreaClass =
  'w-full min-h-[72px] resize-y rounded-control border border-line bg-bg px-2 py-1 font-mono text-[var(--font-code-size)] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
export const formSecondaryButtonClass =
  'h-[var(--control-height-compact)] rounded-control border border-line px-2 text-muted text-[var(--font-meta-size)] hover:text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
/**
 * 与输入框同高的按钮（P10）。
 *
 * 设置页里「拉取模型」「测试连通」这类按钮总是和 `formInputClass` 的输入框并排出现。
 * 用紧凑高度（28px）再配 `items-end`，底边齐了但顶边差 4px，一行的两条基线看起来就是歪的；
 * 高度不一致也让 hover 区域与输入框不是同一条水平带。所以凡是与输入框同排的动作按钮用这个。
 */
export const formButtonClass =
  'h-[var(--control-height)] rounded-control border border-line px-2.5 text-muted text-[var(--font-meta-size)] hover:text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
/** 与输入框同高的主按钮（保存/确认）。 */
export const formPrimaryButtonClass =
  'h-[var(--control-height)] rounded-control border border-line bg-surface-strong px-3 text-ink text-[var(--font-meta-size)] hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export function FormSection({
  title,
  readOnly = false,
  children,
  testId
}: {
  title: string;
  readOnly?: boolean;
  children: ReactNode;
  testId: string;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <header className="flex flex-wrap items-baseline gap-2 border-b border-line pb-1">
        <h3 className="text-ink text-[var(--font-h3-size)]">{title}</h3>
        {readOnly ? (
          <span className="rounded-control border border-line px-1.5 text-subtle text-[var(--font-micro-size)]">
            只读
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

export function Field({
  label,
  issue,
  children,
  testId,
  inline = false
}: {
  label: string;
  issue?: string | null;
  children: ReactNode;
  testId?: string;
  inline?: boolean;
}): React.JSX.Element {
  return (
    <div className={inline ? 'flex items-center gap-2' : 'flex flex-col gap-0.5'} data-testid={testId}>
      <span className="text-subtle text-[var(--font-micro-size)]">{label}</span>
      <div className={inline ? 'flex min-w-0 flex-1 items-center gap-2' : 'flex min-w-0 flex-col gap-1'}>
        {children}
      </div>
      {issue === undefined || issue === null ? null : (
        <span className="flex items-start gap-1 text-[var(--st-warn)] text-[var(--font-micro-size)]" role="alert">
          <AlertTriangle size={11} aria-hidden="true" className="mt-0.5 shrink-0" />
          {issue}
        </span>
      )}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  disabled = false,
  placeholder,
  issue,
  testId,
  type = 'text'
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  issue?: string | null;
  testId: string;
  type?: 'text' | 'password';
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5" data-testid={`${testId}-field`}>
      <span className="text-subtle text-[var(--font-micro-size)]">{label}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
        className={formInputClass}
      />
      {issue === undefined || issue === null ? null : (
        <span className="flex items-start gap-1 text-[var(--st-warn)] text-[var(--font-micro-size)]" role="alert">
          <AlertTriangle size={11} aria-hidden="true" className="mt-0.5 shrink-0" />
          {issue}
        </span>
      )}
    </label>
  );
}

/**
 * A number field backed by local text.
 *
 * Keeping the raw text lets the user clear a field and retype without the draft
 * flipping through `NaN` on every keystroke; the parsed value is committed on blur or
 * Enter. `allowEmpty` maps an empty field to `undefined` (an optional provider option)
 * or `null` (a nullable setting).
 */
export function NumberField({
  label,
  value,
  onChange,
  disabled = false,
  min,
  max,
  step = 1,
  allowEmpty = false,
  emptyValue = undefined,
  issue,
  testId
}: {
  label: string;
  value: number | null | undefined;
  onChange: (next: number | null | undefined) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  allowEmpty?: boolean;
  emptyValue?: null | undefined;
  issue?: string | null;
  testId: string;
}): React.JSX.Element {
  const [text, setText] = useState(() => (value === null || value === undefined ? '' : String(value)));
  useEffect(() => {
    setText(value === null || value === undefined ? '' : String(value));
  }, [value]);

  const commit = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      if (allowEmpty) {
        onChange(emptyValue);
      } else {
        setText(value === null || value === undefined ? '' : String(value));
      }
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      setText(value === null || value === undefined ? '' : String(value));
      return;
    }
    onChange(parsed);
  };

  return (
    <label className="flex flex-col gap-0.5" data-testid={`${testId}-field`}>
      <span className="text-subtle text-[var(--font-micro-size)]">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          }
        }}
        data-testid={testId}
        className={formInputClass}
      />
      {issue === undefined || issue === null ? null : (
        <span className="flex items-start gap-1 text-[var(--st-warn)] text-[var(--font-micro-size)]" role="alert">
          <AlertTriangle size={11} aria-hidden="true" className="mt-0.5 shrink-0" />
          {issue}
        </span>
      )}
    </label>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  disabled = false,
  description,
  testId
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  description?: string;
  testId: string;
}): React.JSX.Element {
  return (
    <label className="flex items-start gap-2" data-testid={`${testId}-field`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-[3px] border border-line accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      />
      <span className="min-w-0">
        <span className="block text-ink text-[var(--font-meta-size)]">{label}</span>
        {description === undefined ? null : (
          <span className="block text-subtle text-[var(--font-micro-size)]">{description}</span>
        )}
      </span>
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  testId
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  testId: string;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5" data-testid={`${testId}-field`}>
      <span className="text-subtle text-[var(--font-micro-size)]">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
        data-testid={testId}
        className={formSelectClass}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A statement of fact from the backend (or of a deliberate absence). Not editable. */
export function FormNote({
  children,
  tone = 'default',
  testId
}: {
  children: ReactNode;
  tone?: 'default' | 'warn';
  testId?: string;
}): React.JSX.Element {
  return (
    <p
      className={
        tone === 'warn'
          ? 'flex items-start gap-1.5 text-[var(--st-warn)] text-[var(--font-meta-size)]'
          : 'flex items-start gap-1.5 text-muted text-[var(--font-meta-size)]'
      }
      data-testid={testId}
      role={tone === 'warn' ? 'note' : undefined}
    >
      {tone === 'warn' ? (
        <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
      ) : (
        <Info size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function KeyValueRow({ label, value, testId }: { label: string; value: string; testId?: string }): React.JSX.Element {
  return (
    <div className="flex gap-2 text-[var(--font-micro-size)]" data-testid={testId}>
      <dt className="w-[110px] shrink-0 text-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 break-words font-mono text-muted">{value}</dd>
    </div>
  );
}
