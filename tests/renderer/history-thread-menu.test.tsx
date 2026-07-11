// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clampHistoryMenuPosition,
  HistoryThreadRow
} from '../../src/renderer/app/sidebar/HistoryThreadMenu';

describe('HistoryThreadMenu', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperties(window, {
      innerWidth: { value: 320, configurable: true },
      innerHeight: { value: 480, configurable: true }
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('history-context-menu')) {
        return createRectangle(112, 40, 310, 470);
      }
      if (this.classList.contains('history-row-main') || this.classList.contains('history-row-more')) {
        return createRectangle(32, 32, 278, 438);
      }
      return createRectangle(0, 0, 0, 0);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('clamps the menu inside the viewport margin', () => {
    expect(clampHistoryMenuPosition({
      requestedX: 310,
      requestedY: 470,
      menuWidth: 112,
      menuHeight: 40,
      viewportWidth: 320,
      viewportHeight: 480,
      margin: 8
    })).toEqual({ x: 200, y: 432 });
  });

  it('opens from More, focuses delete, and restores focus on Escape', async () => {
    await renderRow();
    const opener = queryButton('history-thread-more-thread-1');
    opener.focus();
    await act(async () => opener.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const menu = container.querySelector<HTMLElement>('[role="menu"]');
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(menu).not.toBeNull();
    expect(item).not.toBeNull();
    expect(document.activeElement).toBe(item);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(menu?.style.left).toBe('200px');
    expect(menu?.style.top).toBe('432px');

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('opens from Shift+F10 and closes on outside pointer with focus return', async () => {
    await renderRow();
    const main = queryButton('history-thread-thread-1');
    main.focus();
    await act(async () => {
      main.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(main);
  });

  it('opens from contextmenu pointer coordinates', async () => {
    await renderRow();
    const row = container.querySelector('.history-row');
    expect(row).not.toBeNull();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 310, clientY: 470 }));
    });
    expect(container.querySelector<HTMLElement>('[role="menu"]')?.style.left).toBe('200px');
    expect(container.querySelector<HTMLElement>('[role="menu"]')?.style.top).toBe('432px');
  });

  it('deletes through the existing callback', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    await renderRow(onDelete);
    await act(async () => queryButton('history-thread-more-thread-1').click());
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(item).not.toBeNull();
    await act(async () => item?.click());

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('thread-1');
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  async function renderRow(onDelete = vi.fn().mockResolvedValue(undefined)): Promise<void> {
    await act(async () => {
      root.render(
        <HistoryThreadRow
          item={{ id: 'thread-1', label: '历史会话', meta: '刚刚', icon: 'history' }}
          selected={false}
          onSelect={() => {}}
          onDelete={onDelete}
        />
      );
    });
  }

  function queryButton(testId: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  }
});

function createRectangle(width: number, height: number, left: number, top: number): DOMRect {
  return {
    x: left,
    y: top,
    width,
    height,
    top,
    right: left + width,
    bottom: top + height,
    left,
    toJSON: () => ({})
  };
}
