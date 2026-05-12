import { CompactStatusPill } from './CompactStatusPill';

export function PageHeading({
  flags,
  kicker,
  title
}: {
  flags?: React.ReactNode;
  kicker: string;
  title: string;
}): React.JSX.Element {
  return (
    <div className="page-strip">
      <div className="page-copy">
        <div className="page-kicker">{kicker}</div>
        <h1 className="page-title">{title}</h1>
      </div>
      <div className="page-flags">
        {flags ?? (
          <>
            <CompactStatusPill tone="ok" value="工作区内" />
            <CompactStatusPill tone="info" value="右侧图标栏展开" />
          </>
        )}
      </div>
    </div>
  );
}
