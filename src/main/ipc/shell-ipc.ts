import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import type { ShellConfirmationRequest, ShellConfirmationResult } from '../../shared/types';
import { wrapIpc } from '../services/errors';
import type { LogService } from '../services/log-service';
import type { TimedHandle } from './ipc-common';

export async function confirmShellRequestWithDialog(
  request: ShellConfirmationRequest,
  mainWindow: BrowserWindow,
  logService: Pick<LogService, 'info'>
): Promise<ShellConfirmationResult> {
  /**
   * Test seam (`ROC_SMOKE=1`), registered in `docs/README.md` § 测试 seam.
   *
   * The gates confirm destructive actions through a native message box, which no automation
   * can click. Under smoke the answer is always "confirmed" — and the request is logged
   * *before* answering, so a gate that confirms something still leaves the title and message
   * in the run's logs to audit.
   */
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
}

export function registerShellConfirmIpc(
  timedHandle: TimedHandle,
  mainWindow: BrowserWindow,
  logService: Pick<LogService, 'info'>
): void {
  timedHandle(ipcChannels.shellConfirm, (_event, request: ShellConfirmationRequest) =>
    wrapIpc(async () => await confirmShellRequestWithDialog(request, mainWindow, logService))
  );
}
