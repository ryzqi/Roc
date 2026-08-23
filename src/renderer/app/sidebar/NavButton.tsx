import { memo } from 'react';

import { PreviewIcon } from '../../components/PreviewIcon';
import type { NavItem } from '../types';

// dock 单行紧凑行：图标 + 标签 + 短徽标。完整文案降级为 title tooltip，
// 保证最小窗口高度下所有入口都在固定预算内，不被裁切。
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
      className={active ? 'nav-button nav-button--dock active' : 'nav-button nav-button--dock'}
      data-testid={`nav-${item.id}`}
      title={item.meta}
      type="button"
      onClick={() => onSelect(item)}
    >
      <PreviewIcon name={item.icon} />
      <span className="nav-label">{item.label}</span>
      {item.badge === undefined ? null : (
        <span className={item.badgeTone === 'alert' ? 'nav-badge nav-badge--alert' : 'nav-badge'}>{item.badge}</span>
      )}
    </button>
  );
});
