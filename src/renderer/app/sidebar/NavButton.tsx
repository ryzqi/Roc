import { PreviewIcon } from '../../components/PreviewIcon';
import type { NavItem } from '../types';

export function NavButton({ active, item, onClick }: { active: boolean; item: NavItem; onClick: () => void }): React.JSX.Element {
  return (
    <button
      className={active ? 'nav-button active' : 'nav-button'}
      data-testid={`nav-${item.id}`}
      type="button"
      onClick={onClick}
    >
      <PreviewIcon name={item.icon} />
      <span className="nav-copy">
        <span className="nav-label">{item.label}</span>
        <span className="nav-meta">{item.meta}</span>
      </span>
    </button>
  );
}
