import {useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {AnchoredPopover, type AnchoredPopoverTriggerProps} from './AnchoredPopover';
import './context-menu.css';

export type ContextMenuAction = {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

type MenuContentProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  actions: readonly ContextMenuAction[];
  testId?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export type ContextMenuProps = MenuContentProps & (
  | {renderTrigger: (props: AnchoredPopoverTriggerProps) => ReactNode; anchor?: {x: number; y: number}}
  | {renderTrigger?: never; anchor: {x: number; y: number}}
);

/** One menu contract for an explicit trigger or the coordinates of a context action. */
export function ContextMenu({actions, ...popoverProps}: ContextMenuProps): React.JSX.Element {
  const menuId = useId();
  const firstActionId = actions.find(action => !action.disabled)?.id;
  const [activeId, setActiveId] = useState(firstActionId);
  const tabCloseFrame = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (popoverProps.open) setActiveId(firstActionId);
  }, [popoverProps.open, firstActionId]);
  useLayoutEffect(() => () => {
    if (tabCloseFrame.current !== undefined) cancelAnimationFrame(tabCloseFrame.current);
    tabCloseFrame.current = undefined;
  }, [popoverProps.open]);
  const focusableId = actions.some(action => action.id === activeId && !action.disabled) ? activeId : firstActionId;

  return <AnchoredPopover {...popoverProps} role="menu" className="context-menu-surface">
    <div className="context-menu-items" onKeyDown={event => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.nativeEvent.isComposing) return;
      // Let native Tab and the portal guards place focus before closing. A menu
      // must also close when Shift+Tab returns to its own trigger.
      if (tabCloseFrame.current !== undefined) cancelAnimationFrame(tabCloseFrame.current);
      tabCloseFrame.current = requestAnimationFrame(() => {
        tabCloseFrame.current = undefined;
        popoverProps.onOpenChange(false);
      });
    }}>
      {actions.map((action, index) => <div key={action.id} className="context-menu-entry">
        {action.danger && index > 0 && !actions[index - 1]?.danger
          ? <div role="separator" className="context-menu-separator"/> : null}
        <button type="button" role="menuitem" className="context-menu-item"
          aria-label={action.label}
          aria-describedby={action.shortcut ? `${menuId}-${action.id}-shortcut` : undefined}
          aria-disabled={action.disabled || undefined}
          disabled={action.disabled}
          tabIndex={action.id === focusableId ? 0 : -1}
          data-danger={action.danger || undefined}
          data-context-action={action.id}
          data-testid={popoverProps.testId ? `${popoverProps.testId}-${action.id}` : undefined}
          onFocus={() => setActiveId(action.id)}
          onClick={() => {
            if (action.disabled) return;
            popoverProps.onOpenChange(false);
            action.onSelect();
          }}>
          <span className="context-menu-item-icon" aria-hidden="true">{action.icon}</span>
          <span className="context-menu-item-label">{action.label}</span>
          {action.shortcut
            ? <kbd id={`${menuId}-${action.id}-shortcut`} className="context-menu-item-shortcut">{action.shortcut}</kbd> : null}
        </button>
      </div>)}
    </div>
  </AnchoredPopover>;
}
