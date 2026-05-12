export function Metric({
  label,
  note,
  tone = 'neutral',
  value
}: {
  label: string;
  note: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad';
  value: number | string;
}): React.JSX.Element {
  const toneClass = tone === 'neutral' ? '' : ` metric--${tone}`;
  return (
    <div className={`metric${toneClass}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{note}</small>
    </div>
  );
}
