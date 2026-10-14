import { useEffect, useState } from 'react';
import type { WindowStateSnapshot } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';

/**
 * Live window shell state (maximized / fullscreen / hidden).
 *
 * The backend only pushes `window.onHidden`; maximize and fullscreen changes
 * have no event channel, so they are sampled on resize and on focus. That is
 * deliberately a poll rather than a guess: never infer zoom state in the
 * renderer.
 */

export type WindowShellState = WindowStateSnapshot & { hidden: boolean };

const INITIAL: WindowShellState = { maximized: false, minimized: false, fullscreen: false, hidden: false };

export function useWindowState(client: RocClient): WindowShellState {
  const [state, setState] = useState<WindowShellState>(INITIAL);

  useEffect(() => {
    let cancelled = false;

    const refresh = async (): Promise<void> => {
      const result = await client.api.window.getState();
      if (cancelled || !result.ok) {
        return;
      }
      setState((current) => ({ ...current, ...result.data }));
    };

    void refresh();

    const unsubscribeHidden = client.api.window.onHidden((snapshot) => {
      setState((current) => ({ ...current, hidden: snapshot.hidden }));
    });

    let debounce: number | null = null;
    const onResize = (): void => {
      if (debounce !== null) {
        window.clearTimeout(debounce);
      }
      debounce = window.setTimeout(() => {
        void refresh();
      }, 150);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('focus', onResize);

    return () => {
      cancelled = true;
      unsubscribeHidden();
      if (debounce !== null) {
        window.clearTimeout(debounce);
      }
      window.removeEventListener('resize', onResize);
      window.removeEventListener('focus', onResize);
    };
  }, [client]);

  return state;
}
