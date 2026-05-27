// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../src/renderer/settings/settings-modal';

describe('SettingsModal', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('marks the settings surface as a modal dialog', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsModal, {
        onClose: () => {},
        children: React.createElement('button', { type: 'button' }, 'Provider')
      })
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="设置"');
  });

  it('moves initial focus to the close button', async () => {
    await renderSettingsModal();

    expect(document.activeElement).toBe(queryButton('settings-modal-close'));
  });

  it('keeps Tab focus inside settings modal', async () => {
    await renderSettingsModal();

    const closeButton = queryButton('settings-modal-close');
    const lastButton = queryButton('settings-child-last');

    lastButton.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(closeButton);

    closeButton.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, shiftKey: true }));
    });
    expect(document.activeElement).toBe(lastButton);
  });

  it('closes when Escape is pressed', async () => {
    const onClose = vi.fn();
    await renderSettingsModal(onClose);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  async function renderSettingsModal(onClose: () => void = () => {}): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(SettingsModal, {
          onClose,
          children: React.createElement(
            React.Fragment,
            null,
            React.createElement('button', { 'data-testid': 'settings-child-first', type: 'button' }, 'First'),
            React.createElement('button', { 'data-testid': 'settings-child-last', type: 'button' }, 'Last')
          )
        })
      );
    });
  }

  function queryButton(testId: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  }
});
