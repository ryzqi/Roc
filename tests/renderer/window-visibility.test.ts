import { describe, expect, it, vi } from 'vitest';
import { applyWindowHiddenState, bindWindowVisibility } from '../../src/renderer/window-visibility';

describe('window visibility', () => {
  it('marks the document hidden from the host hide/show event', () => {
    const root = { dataset: {} as DOMStringMap };

    applyWindowHiddenState(true, root);

    expect(root.dataset.windowHidden).toBe('true');
  });

  it('clears the hidden marker when the host shows the window', () => {
    const root = { dataset: { windowHidden: 'true' } as DOMStringMap };

    applyWindowHiddenState(false, root);

    expect(root.dataset.windowHidden).toBe('false');
  });

  it('binds host hide/show events and unbinds on dispose', () => {
    const listeners: Array<(snapshot: { hidden: boolean }) => void> = [];
    const root = { dataset: {} as DOMStringMap };
    const client = {
      api: {
        window: {
          onHidden: vi.fn((callback: (snapshot: { hidden: boolean }) => void) => {
            listeners.push(callback);
            return () => {
              const index = listeners.indexOf(callback);
              if (index !== -1) {
                listeners.splice(index, 1);
              }
            };
          })
        }
      }
    };

    const dispose = bindWindowVisibility(client, root);
    expect(client.api.window.onHidden).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(1);

    listeners[0]?.({ hidden: true });
    expect(root.dataset.windowHidden).toBe('true');

    listeners[0]?.({ hidden: false });
    expect(root.dataset.windowHidden).toBe('false');

    dispose();
    expect(listeners).toHaveLength(0);
  });
});
