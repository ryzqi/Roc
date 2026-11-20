import type { BrowserWindow } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import { wrapIpc } from '../services/errors';
import { getWindowBounds, getWindowState } from '../window-shell';
import type { TimedHandle } from './ipc-common';
import type { AppWindowControls } from './register-ipc';

export function registerWindowIpc(
  timedHandle: TimedHandle,
  mainWindow: BrowserWindow,
  controls: Pick<AppWindowControls, 'closeMainWindow'>
): void {
  timedHandle(ipcChannels.windowGetState, () => wrapIpc(() => getWindowState(mainWindow)));
  timedHandle(ipcChannels.windowGetBounds, () => wrapIpc(() => getWindowBounds(mainWindow)));
  timedHandle(ipcChannels.windowMinimize, () =>
    wrapIpc(() => {
      mainWindow.minimize();
      return getWindowState(mainWindow);
    })
  );
  timedHandle(ipcChannels.windowToggleMaximize, () =>
    wrapIpc(() => {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      return getWindowState(mainWindow);
    })
  );
  timedHandle(ipcChannels.windowClose, () =>
    wrapIpc(() => {
      controls.closeMainWindow();
      return { closed: true as const };
    })
  );
}
