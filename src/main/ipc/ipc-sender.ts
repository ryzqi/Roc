import type {BrowserWindow, IpcMainInvokeEvent} from 'electron';

/** Bind IPC authority to our window, its live top frame, and the configured entry. */
export function createIpcSenderValidator(mainWindow: BrowserWindow, rendererUrl: string): (event: IpcMainInvokeEvent) => boolean {
  const expected = new URL(rendererUrl);
  return (event) => {
    if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    const frame = event.senderFrame;
    if (frame === null || frame.detached || frame !== mainWindow.webContents.mainFrame) return false;
    try {
      const actual = new URL(frame.url);
      // file: origins alone cannot distinguish trusted application files.
      const origin = expected.protocol === 'file:' ? 'file://' : expected.origin;
      return frame.origin === origin && actual.protocol === expected.protocol &&
        actual.host === expected.host && actual.pathname === expected.pathname &&
        actual.username === '' && actual.password === '';
    } catch {
      return false;
    }
  };
}
