import { memo } from 'react';

import { PreviewIcon } from '../../components/PreviewIcon';
import type { NavItem } from '../types';

export const NavButton = memo(function NavButton({
  active,
  item,
  onSelect
}: {
  active: boolean;
  item: NavItem;
  onSelect: (item: NavItem) => void;
}): React.JSX.Element {
  return (
    <button
      className={active ? 'nav-button active' : 'nav-button'}
      data-testid={`nav-${item.id}`}
      type="button"
      onClick={() => onSelect(item)}
    >
      <PreviewIcon name={item.icon} />
      <span className="nav-copy">
        <span className="nav-label">{item.label}</span>
        <span className="nav-meta">{item.meta}</span>
      </span>
    </button>
  );
});
