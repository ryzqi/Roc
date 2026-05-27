// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDraggedWindowBounds,
  canStartWindowDrag,
  useWindowDrag
} from '../../src/renderer/app/use-window-drag';
import type { WindowBoundsSnapshot } from '../../src/shared/types';
import type { IpcLikeResult } from '../../src/renderer/loaded-state';

describe('use window drag helpers', () => {
  it('blocks drag start for non-left button, maximized/fullscreen, and workband action targets', () => {
    expect(
      canStartWindowDrag({
        button: 1,
        maximized: false,
        fullscreen: false,
        targetWithinActions: false
      })
    ).toBe(false);
    expect(
      canStartWindowDrag({
        button: 0,
        maximized: true,
        fullscreen: false,
        targetWithinActions: false
      })
    ).toBe(false);
    expect(
      canStartWindowDrag({
        button: 0,
        maximized: false,
        fullscreen: true,
        targetWithinActions: false
      })
    ).toBe(false);
    expect(
      canStartWindowDrag({
        button: 0,
        maximized: false,
        fullscreen: false,
        targetWithinActions: true
      })
    ).toBe(false);
  });

  it('allows drag start only from the plain workband drag region', () => {
    expect(
      canStartWindowDrag({
        button: 0,
        maximized: false,
        fullscreen: false,
        targetWithinActions: false
      })
    ).toBe(true);
  });

  it('rebuilds window bounds from the captured drag session offsets', () => {
    expect(
      buildDraggedWindowBounds({
        clientX: 420.6,
        clientY: 155.2,
        session: {
          pointerId: 7,
          offsetX: 20.4,
          offsetY: 35.7,
          width: 1280,
          height: 820
        }
      })
    ).toEqual({
      x: 400,
      y: 119,
      width: 1280,
      height: 820
      });
  });

  it('applies the last pointer move that happens before window bounds resolve', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let resolveBounds: (result: IpcLikeResult<WindowBoundsSnapshot>) => void = () => {};
    const getBounds = vi.fn(
      () =>
        new Promise<IpcLikeResult<WindowBoundsSnapshot>>((resolve) => {
          resolveBounds = resolve;
        })
    );
    const setBounds = vi.fn().mockResolvedValue({ ok: true, data: { updated: true } });
    Object.defineProperty(window, 'roc', {
      configurable: true,
      value: {
        window: {
          getBounds,
          setBounds
        }
      }
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let controls: ReturnType<typeof useWindowDrag> | null = null;

    await act(async () => {
      root.render(
        React.createElement(WindowDragHarness, {
          onReady: (nextControls) => {
            controls = nextControls;
          }
        })
      );
    });
    const dragControls = controls as ReturnType<typeof useWindowDrag> | null;
    if (dragControls === null) {
      throw new Error('Window drag controls were not initialized.');
    }

    const dragTarget = document.createElement('div');
    dragControls.startWindowDrag({
      button: 0,
      clientX: 125,
      clientY: 95,
      pointerId: 7,
      preventDefault: vi.fn(),
      target: dragTarget
    } as unknown as React.PointerEvent<HTMLElement>);
    dragControls.continueWindowDrag(300, 180);
    dragControls.finishWindowDrag(7);

    expect(getBounds).toHaveBeenCalledTimes(1);
    expect(setBounds).not.toHaveBeenCalled();

    await act(async () => {
      resolveBounds({
        ok: true,
        data: {
          x: 80,
          y: 50,
          width: 900,
          height: 700
        }
      });
      await Promise.resolve();
    });

    expect(setBounds).toHaveBeenCalledWith({
      x: 255,
      y: 135,
      width: 900,
      height: 700
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

function WindowDragHarness({
  onReady
}: {
  onReady: (controls: ReturnType<typeof useWindowDrag>) => void;
}): React.JSX.Element {
  const controls = useWindowDrag({ maximized: false, minimized: false, fullscreen: false });
  useEffect(() => {
    onReady(controls);
  }, [controls, onReady]);
  return React.createElement('div');
}
