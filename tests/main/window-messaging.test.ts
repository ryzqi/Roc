import { describe, expect, it, vi } from 'vitest';
import { broadcastToWindows, sendToWindow } from '../../src/main/window-messaging';

function createWindow(options?: { windowDestroyed?: boolean; contentsDestroyed?: boolean }) {
  const send = vi.fn();
  return {
    isDestroyed: () => options?.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => options?.contentsDestroyed ?? false,
      send
    },
    send
  };
}

describe('window messaging', () => {
  it('sends payload to a live window', () => {
    const window = createWindow();

    const delivered = sendToWindow(window, 'roc:terminal:output', { sessionId: '1', data: 'dir' });

    expect(delivered).toBe(true);
    expect(window.send).toHaveBeenCalledWith('roc:terminal:output', { sessionId: '1', data: 'dir' });
  });

  it('skips destroyed BrowserWindow instances', () => {
    const window = createWindow({ windowDestroyed: true });

    const delivered = sendToWindow(window, 'roc:terminal:output', { sessionId: '1', data: 'dir' });

    expect(delivered).toBe(false);
    expect(window.send).not.toHaveBeenCalled();
  });

  it('skips destroyed webContents instances', () => {
    const window = createWindow({ contentsDestroyed: true });

    const delivered = sendToWindow(window, 'roc:terminal:exit', { sessionId: '1', exitCode: 0 });

    expect(delivered).toBe(false);
    expect(window.send).not.toHaveBeenCalled();
  });

  it('broadcasts only to live windows', () => {
    const liveWindow = createWindow();
    const destroyedWindow = createWindow({ windowDestroyed: true });
    const destroyedContentsWindow = createWindow({ contentsDestroyed: true });

    broadcastToWindows(
      [liveWindow, destroyedWindow, destroyedContentsWindow, null],
      'roc:terminal:output',
      { sessionId: '1', data: 'dir' }
    );

    expect(liveWindow.send).toHaveBeenCalledWith('roc:terminal:output', { sessionId: '1', data: 'dir' });
    expect(destroyedWindow.send).not.toHaveBeenCalled();
    expect(destroyedContentsWindow.send).not.toHaveBeenCalled();
  });

  it('can filter broadcasts to subscribed windows', () => {
    const mainWindow = createWindow();
    const quickWindow = createWindow();
    const trayWindow = createWindow();

    broadcastToWindows(
      [mainWindow, quickWindow, trayWindow],
      'roc:chat:run-event',
      { runId: 'chat_1', type: 'message' },
      {
        include: (_window, index) => index === 0
      }
    );

    expect(mainWindow.send).toHaveBeenCalledWith('roc:chat:run-event', { runId: 'chat_1', type: 'message' });
    expect(quickWindow.send).not.toHaveBeenCalled();
    expect(trayWindow.send).not.toHaveBeenCalled();
  });
});
