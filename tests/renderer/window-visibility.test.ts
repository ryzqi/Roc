import { describe, expect, it, vi } from 'vitest';
import { bindWindowVisibility, syncWindowHiddenState } from '../../src/renderer/window-visibility';

describe('window visibility', () => {
  it('marks the document hidden while the resident window is occluded', () => {
    const root = {
      documentElement: { dataset: {} as DOMStringMap },
      visibilityState: 'hidden' as DocumentVisibilityState
    };

    syncWindowHiddenState(root);

    expect(root.documentElement.dataset.windowHidden).toBe('true');
  });

  it('clears the hidden marker when the window is visible again', () => {
    const root = {
      documentElement: { dataset: { windowHidden: 'true' } as DOMStringMap },
      visibilityState: 'visible' as DocumentVisibilityState
    };

    syncWindowHiddenState(root);

    expect(root.documentElement.dataset.windowHidden).toBe('false');
  });

  it('binds visibilitychange and unbinds on dispose', () => {
    const listeners = new Map<string, () => void>();
    const root = {
      documentElement: { dataset: {} as DOMStringMap },
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: vi.fn((type: 'visibilitychange', listener: () => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: 'visibilitychange', listener: () => void) => {
        if (listeners.get(type) === listener) {
          listeners.delete(type);
        }
      })
    };

    const dispose = bindWindowVisibility(root);
    expect(root.documentElement.dataset.windowHidden).toBe('false');
    expect(listeners.has('visibilitychange')).toBe(true);

    root.visibilityState = 'hidden';
    listeners.get('visibilitychange')?.();
    expect(root.documentElement.dataset.windowHidden).toBe('true');

    dispose();
    expect(root.removeEventListener).toHaveBeenCalledTimes(1);
    expect(listeners.has('visibilitychange')).toBe(false);
  });
});
