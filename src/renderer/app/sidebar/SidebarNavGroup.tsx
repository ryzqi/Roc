import type { ViewId, NavItem } from '../types';
import { NavButton } from './NavButton';

export function SidebarNavGroup({
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
    <div className={className === undefined ? 'sidebar-block' : className}>
      <div className="side-title">{title}</div>
      <nav className="sidebar-block-scroll nav-list" aria-label={title}>
        {items.map((item) => (
          <NavButton active={item.active ?? item.id === activeView} item={item} key={item.id} onClick={() => onSelect(item)} />
        ))}
      </nav>
    </div>
  );
}
