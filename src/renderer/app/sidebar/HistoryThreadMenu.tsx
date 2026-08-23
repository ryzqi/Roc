import { MoreHorizontal } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { HistorySidebarItem } from '../../history-sidebar';
import { restoreDialogFocus } from '../../dialog-focus';
import { PreviewIcon } from '../../components/PreviewIcon';
import { sanitizeTestId } from '../../utils/sanitize-test-id';

type MenuState = {
  requestedX: number;
  requestedY: number;
  opener: HTMLElement;
};

export function clampHistoryMenuPosition(input: {
  requestedX: number;
  requestedY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin: number;
}): { x: number; y: number } {
  const maximumX = Math.max(input.margin, input.viewportWidth - input.menuWidth - input.margin);
  const maximumY = Math.max(input.margin, input.viewportHeight - input.menuHeight - input.margin);
  return {
    x: Math.min(Math.max(input.requestedX, input.margin), maximumX),
    y: Math.min(Math.max(input.requestedY, input.margin), maximumY)
  };
}

export const HistoryThreadRow = memo(function HistoryThreadRow(props: {
  item: HistorySidebarItem;
  selected: boolean;
  onSelect(threadId: string): void;
  onDelete(threadId: string): Promise<void>;
}): React.JSX.Element {
  const mainButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuState, setMenuState] = useState<MenuState | null>(null);
  const [position, setPosition] = useState({ x: 8, y: 8 });

  function closeMenu(): void {
    const opener = menuState?.opener ?? null;
    setMenuState(null);
    restoreDialogFocus(opener);
  }

  function openAt(requestedX: number, requestedY: number, opener: HTMLElement): void {
    setPosition({ x: requestedX, y: requestedY });
    setMenuState({ requestedX, requestedY, opener });
  }

  function openFromElement(opener: HTMLElement): void {
    const rectangle = opener.getBoundingClientRect();
    openAt(rectangle.right, rectangle.bottom, opener);
  }

  useLayoutEffect(() => {
    if (menuState === null || menuRef.current === null) {
      return;
    }
    const rectangle = menuRef.current.getBoundingClientRect();
    setPosition(clampHistoryMenuPosition({
      requestedX: menuState.requestedX,
      requestedY: menuState.requestedY,
      menuWidth: rectangle.width,
      menuHeight: rectangle.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin: 8
    }));
    menuRef.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuState]);

  useEffect(() => {
    if (menuState === null) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    }
    function handlePointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) {
        return;
      }
      closeMenu();
    }
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [menuState]);

  return (
    <div
      className={props.selected ? 'history-row active' : 'history-row'}
      onContextMenu={(event) => {
        event.preventDefault();
        if (mainButtonRef.current !== null) {
          openAt(event.clientX, event.clientY, mainButtonRef.current);
        }
      }}
    >
      <button
        ref={mainButtonRef}
        className="history-row-main"
        data-testid={`history-thread-${sanitizeTestId(props.item.id)}`}
        type="button"
        onClick={() => props.onSelect(props.item.id)}
        onKeyDown={(event) => {
          if (event.key === 'F10' && event.shiftKey && mainButtonRef.current !== null) {
            event.preventDefault();
            openFromElement(mainButtonRef.current);
          }
        }}
      >
        <PreviewIcon name={props.item.icon} />
        <span className="nav-copy">
          <span className="nav-label">{props.item.label}</span>
          <span className="nav-meta">{props.item.meta}</span>
        </span>
      </button>
      <button
        ref={moreButtonRef}
        aria-expanded={menuState !== null}
        aria-haspopup="menu"
        aria-label="更多历史会话操作"
        className="history-row-more"
        data-testid={`history-thread-more-${sanitizeTestId(props.item.id)}`}
        title="更多操作"
        type="button"
        onClick={(event) => openFromElement(event.currentTarget)}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && moreButtonRef.current !== null) {
            event.preventDefault();
            openFromElement(moreButtonRef.current);
          }
        }}
      >
        <MoreHorizontal aria-hidden="true" size={16} />
      </button>
      {menuState === null
        ? null
        : createPortal(
            // 挂到 body：菜单是 position: fixed，留在行内会被 .history-row:active 的
            // transform 变成包含块，按下瞬间整体偏移，click 落不到菜单项上。
            <div
              className="history-context-menu"
              ref={menuRef}
              role="menu"
              style={{ left: position.x, top: position.y }}
            >
              <button
                data-testid="history-thread-delete"
                role="menuitem"
                type="button"
                onClick={() => {
                  void props.onDelete(props.item.id).finally(closeMenu);
                }}
              >
                删除
              </button>
            </div>,
            document.body
          )}
    </div>
  );
});
