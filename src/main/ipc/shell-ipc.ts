import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import type { ShellConfirmationRequest } from '../../shared/types';
import { wrapIpc } from '../services/errors';
import type { LogService } from '../services/log-service';
import type { ShellExecutionService } from '../services/shell-execution-service';
import type { TimedHandle } from './ipc-common';

export function registerShellIpc(
  timedHandle: TimedHandle,
  mainWindow: BrowserWindow,
  logService: Pick<LogService, 'append'>,
  shellExecutionService: ShellExecutionService
): void {
  timedHandle(ipcChannels.shellConfirm, (_event, request: ShellConfirmationRequest) =>
    wrapIpc(async () => {
      if (process.env.ROC_SMOKE === '1') {
        logService.append({
          level: 'info',
          message: 'Native confirmation auto-accepted for smoke.',
          data: {
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
  timedHandle(ipcChannels.shellExecute, (_event, request) => wrapIpc(() => shellExecutionService.executeAsync(request)));
}
