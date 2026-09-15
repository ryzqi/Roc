import { describe, expect, it } from 'vitest';
import { CHAT_WINDOW_MIN_WIDTH } from '../../src/shared/chat-layout';
import {
  bindWindowHiddenBroadcast,
  buildMainWindowOptions,
  getWindowBounds,
  getWindowHiddenState,
  getWindowState,
  resolveMainWindowBounds
} from '../../src/main/window-shell';

describe('immersive window shell', () => {
  it('uses native macOS traffic lights within the workband', () => {
    const options = buildMainWindowOptions('/roc/dist/preload/index.cjs');

    expect(options.title).toBe('Roc');
    expect(options.titleBarStyle).toBe('hiddenInset');
    expect(options.trafficLightPosition).toEqual({ x: 14, y: 13 });
    expect(options.frame).not.toBe(false);
    expect(options.show).toBe(false);
    expect(options).not.toHaveProperty('backgroundMaterial');
    expect(options.webPreferences?.preload).toBe('/roc/dist/preload/index.cjs');
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.sandbox).toBe(false);
    expect(options.webPreferences?.backgroundThrottling).toBe(true);
    expect(options.webPreferences).not.toHaveProperty('spellcheck');
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
    const options = buildMainWindowOptions('/roc/dist/preload/index.cjs', restored);

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
    expect(options.minWidth).toBe(CHAT_WINDOW_MIN_WIDTH);
    expect(options.minWidth).toBeGreaterThan(1180);
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

  it('treats minimized or invisible windows as hidden', () => {
    expect(
      getWindowHiddenState({
        isVisible: () => false,
        isMinimized: () => false
      })
    ).toEqual({ hidden: true });
    expect(
      getWindowHiddenState({
        isVisible: () => true,
        isMinimized: () => true
      })
    ).toEqual({ hidden: true });
    expect(
      getWindowHiddenState({
        isVisible: () => true,
        isMinimized: () => false
      })
    ).toEqual({ hidden: false });
  });

  it('broadcasts host hide and show events without waiting on Page Visibility', () => {
    const handlers = new Map<string, () => void>();
    const snapshots: Array<{ hidden: boolean }> = [];
    let visible = true;
    const window = {
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
      },
      isVisible: () => visible,
      isMinimized: () => false
    };

    bindWindowHiddenBroadcast(window, (snapshot) => {
      snapshots.push(snapshot);
    });

    visible = false;
    handlers.get('hide')?.();
    visible = true;
    handlers.get('show')?.();

    expect(snapshots).toEqual([{ hidden: false }, { hidden: true }, { hidden: false }]);
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
