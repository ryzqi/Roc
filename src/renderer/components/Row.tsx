export function Row({
  sub,
  tag,
  title,
  tone = 'neutral'
}: {
  sub?: string;
  tag: string;
  title: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
}): React.JSX.Element {
  return (
    <div className="row">
      <div>
        <div className="row-title">{title}</div>
        {sub === undefined ? null : <div className="row-sub">{sub}</div>}
      </div>
      <span className={`pill ${tone}`}>{tag}</span>
    </div>
  );
}
