/** A labeled row of immediate appearance choices, shared by all four preference controls. */
export function PreferenceRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testId
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  testId: string;
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-ink">{label}</span>
      <div className="inline-flex flex-wrap gap-1 rounded-control border-[0.5px] border-line bg-bg-soft p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            data-testid={`${testId}-${option.value}`}
            onClick={() => onChange(option.value)}
            className="min-h-[var(--control-height-compact)] rounded-control px-3 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] aria-pressed:bg-[var(--overlay-active)] aria-pressed:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
