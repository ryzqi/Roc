import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import type { ShellConfirmationRequest } from '../../shared/types';
import { wrapIpc } from '../services/errors';
import type { LogService } from '../services/log-service';
import type { TimedHandle } from './ipc-common';

export function registerShellConfirmIpc(
  timedHandle: TimedHandle,
  mainWindow: BrowserWindow,
  logService: Pick<LogService, 'info'>
): void {
  timedHandle(ipcChannels.shellConfirm, (_event, request: ShellConfirmationRequest) =>
    wrapIpc(async () => {
      if (process.env.ROC_SMOKE === '1') {
        logService.info('Native confirmation auto-accepted for smoke.', {
          service: 'shell-ipc',
          component: 'shellConfirm',
          metadata: {
            title: request.title,
            message: request.message
          }
        });
        return {
          confirmed: true,
          response: 0
        };
      }
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: request.title,
        message: request.message,
        buttons: [request.confirmLabel, request.cancelLabel],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      return {
        confirmed: result.response === 0,
        response: result.response
      };
    })
  );
}
