import { describe, expect, it } from 'vitest';
import { buildMainWindowOptions, getWindowState } from '../../src/main/window-shell';

describe('immersive window shell', () => {
  it('builds a frameless window with hidden system menu bar', () => {
    const options = buildMainWindowOptions('C:/roc/dist/preload/index.mjs');

    expect(options.frame).toBe(false);
    expect(options.autoHideMenuBar).toBe(true);
    expect(options.show).toBe(false);
    expect(options.webPreferences?.preload).toBe('C:/roc/dist/preload/index.mjs');
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
  });

  it('maps BrowserWindow state into renderer-safe window state', () => {
    const state = getWindowState({
      isMaximized: () => true,
      isMinimized: () => false,
      isFullScreen: () => false
    });

    expect(state).toEqual({
      maximized: true,
      minimized: false,
      fullscreen: false
    });
  });
});
