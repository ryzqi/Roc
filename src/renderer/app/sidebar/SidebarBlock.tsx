import type { ReactNode } from 'react';

// 侧栏区块的唯一外壳：div.sidebar-block > div.side-title > [head] > div.sidebar-block-scroll。
// 导航分组与历史区块都走这一条渲染路径，避免两套并行结构。
export function SidebarBlock({
  ariaLabel,
  children,
  className,
  head,
  scrollClassName,
  title
}: {
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  head?: ReactNode;
  scrollClassName: string;
  title: string;
}): React.JSX.Element {
  // 带 ariaLabel 的区块是导航地标，用 nav；历史列表是普通滚动面，用 div。
  const ScrollElement = ariaLabel === undefined ? 'div' : 'nav';
  return (
    <div className={className === undefined ? 'sidebar-block' : className}>
      <div className="side-title">{title}</div>
      {head}
      <ScrollElement aria-label={ariaLabel} className={`sidebar-block-scroll ${scrollClassName}`}>
        {children}
      </ScrollElement>
    </div>
  );
}
