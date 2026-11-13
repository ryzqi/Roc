import { useCallback, useEffect, useState } from 'react';
import type { WindowStateSnapshot } from '../../shared/types';
import { errorMessage } from '../app/loaded-state';
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
export type WindowStateResource = WindowShellState & { error: string | null; reload: () => void };

const INITIAL: WindowShellState = { maximized: false, minimized: false, fullscreen: false, hidden: false };

export function useWindowState(client: RocClient): WindowStateResource {
  const [snapshot, setSnapshot] = useState<{client: RocClient; state: WindowShellState; error: string | null}>({
    client, state: INITIAL, error: null
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce(current => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    let revision = 0;

    const refresh = async (): Promise<void> => {
      const request = ++revision;
      try {
        const result = await client.api.window.getState();
        if (cancelled || request !== revision) return;
        if (!result.ok) {
          setSnapshot(current => ({
            client, state: current.client === client ? current.state : INITIAL, error: result.error.message
          }));
          return;
        }
        setSnapshot(current => ({
          client, state: {...(current.client === client ? current.state : INITIAL), ...result.data}, error: null
        }));
      } catch (error) {
        if (!cancelled && request === revision) {
          setSnapshot(current => ({
            client, state: current.client === client ? current.state : INITIAL, error: errorMessage(error)
          }));
        }
      }
    };

    void refresh();

    const unsubscribeHidden = client.api.window.onHidden((snapshot) => {
      if (cancelled) return;
      setSnapshot(current => ({
        client, state: {...(current.client === client ? current.state : INITIAL), hidden: snapshot.hidden},
        error: current.client === client ? current.error : null
      }));
    });

    let debounce: number | null = null;
    const onResize = (): void => {
      if (debounce !== null) {
        window.clearTimeout(debounce);
      }
      debounce = window.setTimeout(() => {
        debounce = null;
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
  }, [client, nonce]);

  return {...(snapshot.client === client ? snapshot.state : INITIAL), error: snapshot.client === client ? snapshot.error : null, reload};
}
