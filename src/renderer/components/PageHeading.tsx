export function PageHeading({
  flags,
  meta,
  title
}: {
  flags?: React.ReactNode;
  meta?: string;
  title: string;
}): React.JSX.Element {
  return (
    <div className="page-strip">
      <div className="page-copy">
        <h1 className="page-title">{title}</h1>
        {meta === undefined ? null : <div className="page-meta">{meta}</div>}
      </div>
      {flags === undefined ? null : <div className="page-flags">{flags}</div>}
    </div>
  );
}
