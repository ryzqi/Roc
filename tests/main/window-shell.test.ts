import { describe, expect, it } from 'vitest';
import { buildMainWindowOptions, getWindowBounds, getWindowState } from '../../src/main/window-shell';

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

  it('maps BrowserWindow bounds into renderer-safe bounds snapshot', () => {
    const bounds = getWindowBounds({
      getBounds: () => ({
        x: 120,
        y: 80,
        width: 1320,
        height: 860
      })
    });

    expect(bounds).toEqual({
      x: 120,
      y: 80,
      width: 1320,
      height: 860
    });
  });
});
