export function CompactStatusPill({
  tone = 'neutral',
  value
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
  value: string;
}): React.JSX.Element {
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot"></span>
      <span>{value}</span>
    </span>
  );
}
