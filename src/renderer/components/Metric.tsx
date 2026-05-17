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
      <strong className="metric-value">{value}</strong>
      <span className="metric-label">{label}</span>
      <small className="metric-note">{note}</small>
    </div>
  );
}
