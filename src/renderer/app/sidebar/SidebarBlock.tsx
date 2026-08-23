import type { ReactNode } from 'react';

// 侧栏区块的唯一外壳：div.sidebar-block > div.side-title > [head] > div.sidebar-block-scroll。
// a11y 地标由 nav.sidebar-dock 承担，这里固定是普通滚动面。
export function SidebarBlock({
  children,
  className,
  head,
  scrollClassName,
  title
}: {
  children: ReactNode;
  className?: string;
  head?: ReactNode;
  scrollClassName: string;
  title: string;
}): React.JSX.Element {
  return (
    <div className={className === undefined ? 'sidebar-block' : className}>
      <div className="side-title">{title}</div>
      {head}
      <div className={`sidebar-block-scroll ${scrollClassName}`}>{children}</div>
    </div>
  );
}
