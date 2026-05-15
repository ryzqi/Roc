export function CompactStatusPill({
  tone = 'neutral',
  value
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
  value: string;
}): React.JSX.Element {
  return (
    <span className={`status-pill ${tone}`}>
      <span>{value}</span>
    </span>
  );
}
