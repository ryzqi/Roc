export function ToolRow({
  label,
  value,
  tone = 'neutral'
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
}): React.JSX.Element {
  return (
    <div className={`tool-row ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
