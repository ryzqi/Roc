// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog, Drawer } from '../../src/renderer/components/ui';

describe('shared modal surfaces', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps Drawer focus contained, closes from Escape and backdrop, then restores focus', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();

    await act(async () => {
      root.render(<Drawer onClose={onClose} open title="模型"><button data-testid="drawer-last" type="button">Last</button></Drawer>);
    });

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const first = dialog?.querySelector<HTMLButtonElement>('button');
    const last = container.querySelector<HTMLButtonElement>('[data-testid="drawer-last"]');
    expect(document.activeElement).toBe(first);

    last?.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' })));
    expect(document.activeElement).toBe(first);

    first?.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab', shiftKey: true })));
    expect(document.activeElement).toBe(last);

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => container.querySelector<HTMLElement>('.ui-drawer-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(2);

    await act(async () => root.render(<Drawer onClose={onClose} open={false} title="模型">Body</Drawer>));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('keeps ConfirmDialog focus contained, cancels from Escape and backdrop, then restores focus', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(<ConfirmDialog confirmLabel="确认" description="确认操作" onCancel={onCancel} onConfirm={() => {}} open title="确认" />);
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button');
    expect(document.activeElement).toBe(buttons[0]);

    buttons[1]?.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' })));
    expect(document.activeElement).toBe(buttons[0]);

    buttons[0]?.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab', shiftKey: true })));
    expect(document.activeElement).toBe(buttons[1]);

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await act(async () => container.querySelector<HTMLElement>('.ui-dialog-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(2);

    await act(async () => root.render(<ConfirmDialog confirmLabel="确认" description="确认操作" onCancel={onCancel} onConfirm={() => {}} open={false} title="确认" />));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
