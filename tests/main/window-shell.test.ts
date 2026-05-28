import { describe, expect, it } from 'vitest';
import {
  buildFloatingWindowOptions,
  buildMainWindowOptions,
  getWindowBounds,
  getWindowState,
  resolveFloatingWindowBounds,
  resolveMainWindowBounds
} from '../../src/main/window-shell';

describe('immersive window shell', () => {
  it('builds a frameless window with hidden system menu bar', () => {
    const options = buildMainWindowOptions('C:/roc/dist/preload/index.mjs');

    expect(options.frame).toBe(false);
    expect(options.autoHideMenuBar).toBe(true);
    expect(options.show).toBe(false);
    expect(options.backgroundMaterial).toBe('mica');
    expect(options.webPreferences?.preload).toBe('C:/roc/dist/preload/index.mjs');
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.sandbox).toBe(false);
  });

  it('applies restored main-window bounds after display-safe normalization', () => {
    const restored = resolveMainWindowBounds(
      {
        x: 2600,
        y: 140,
        width: 1600,
        height: 980
      },
      [
        {
          workArea: {
            x: 1920,
            y: 0,
            width: 1280,
            height: 720
          }
        }
      ]
    );
    const options = buildMainWindowOptions('C:/roc/dist/preload/index.mjs', restored);

    expect(restored).toEqual({
      x: 1920,
      y: 0,
      width: 1280,
      height: 720
    });
    expect(options.x).toBe(1920);
    expect(options.y).toBe(0);
    expect(options.width).toBe(1280);
    expect(options.height).toBe(720);
    expect(options.minWidth).toBeLessThanOrEqual(920);
    expect(options.minHeight).toBeLessThanOrEqual(640);
  });

  it('centers the main window on the active display when saved bounds are off-screen', () => {
    const restored = resolveMainWindowBounds(
      {
        x: -4000,
        y: -3000,
        width: 1320,
        height: 860
      },
      [
        {
          workArea: {
            x: 0,
            y: 0,
            width: 1600,
            height: 900
          }
        }
      ]
    );

    expect(restored).toEqual({
      x: 140,
      y: 20,
      width: 1320,
      height: 860
    });
  });

  it('positions floating entries inside the current display work area', () => {
    const currentDisplay = {
      workArea: {
        x: 1920,
        y: 0,
        width: 1280,
        height: 720
      }
    };

    expect(resolveFloatingWindowBounds('quick', currentDisplay)).toEqual({
      x: 2180,
      y: 125,
      width: 760,
      height: 470
    });
    expect(resolveFloatingWindowBounds('tray', currentDisplay)).toEqual({
      x: 2816,
      y: 246,
      width: 360,
      height: 450
    });
    expect(buildFloatingWindowOptions('C:/roc/dist/preload/index.mjs', 'Roc Quick Entry').backgroundMaterial).toBe('acrylic');
  });

  it('keeps tray entry inside small display work areas', () => {
    const bounds = resolveFloatingWindowBounds('tray', {
      workArea: {
        x: 0,
        y: 0,
        width: 300,
        height: 320
      }
    });

    expect(bounds).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 320
    });
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
