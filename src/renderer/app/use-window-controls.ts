import { useCallback } from 'react';

import type { WindowStateSnapshot } from '../../shared/types';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import type { AppBootstrap } from './use-app-bootstrap';

export function useWindowControls(client: RocClient, setWindowState: AppBootstrap['setWindowState']): {
  closeWindow: () => void;
  minimizeWindow: () => void;
  toggleWindowMaximize: () => void;
} {
  const closeWindow = useCallback((): void => {
    void client.api.window.close();
  }, [client]);
  const toggleWindowMaximize = useCallback((): void => {
    void client.api.window.toggleMaximize().then((result) => {
      setWindowState(unwrap<WindowStateSnapshot>('window toggle maximize', result));
    });
  }, [client, setWindowState]);
  const minimizeWindow = useCallback((): void => {
    void client.api.window.minimize().then((result) => {
      setWindowState(unwrap<WindowStateSnapshot>('window minimize', result));
    });
  }, [client, setWindowState]);

  return {
    closeWindow,
    minimizeWindow,
    toggleWindowMaximize
  };
}
