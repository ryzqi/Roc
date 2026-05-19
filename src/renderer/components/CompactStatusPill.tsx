export function CompactStatusPill({
  className = 'status-pill',
  tone = 'neutral',
  value
}: {
  className?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
  value: string;
}): React.JSX.Element {
  return (
    <span className={`${className} ${tone}`}>
      <span>{value}</span>
    </span>
  );
}
