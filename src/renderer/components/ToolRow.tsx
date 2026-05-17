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
      <span className="tool-row-label">{label}</span>
      <strong className="tool-row-value">{value}</strong>
    </div>
  );
}
