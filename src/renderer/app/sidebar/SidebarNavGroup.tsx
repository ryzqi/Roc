import { memo } from 'react';

import type { ViewId, NavItem } from '../types';
import { NavButton } from './NavButton';
import { SidebarBlock } from './SidebarBlock';

export const SidebarNavGroup = memo(function SidebarNavGroup({
  activeView,
  className,
  items,
  onSelect,
  title
}: {
  activeView: ViewId;
  className?: string;
  items: NavItem[];
  onSelect: (item: NavItem) => void;
  title: string;
}): React.JSX.Element {
  return (
    <SidebarBlock ariaLabel={title} className={className} scrollClassName="nav-list" title={title}>
      {items.map((item) => (
        <NavButton active={item.active ?? item.id === activeView} item={item} key={item.id} onSelect={onSelect} />
      ))}
    </SidebarBlock>
  );
});
