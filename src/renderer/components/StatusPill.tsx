export function StatusPill({
  label,
  value,
  tone = 'neutral'
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
}): React.JSX.Element {
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot"></span>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}
