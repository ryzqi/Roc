import { describe, expect, it } from 'vitest';
import { buildDraggedWindowBounds, canStartWindowDrag } from '../../src/renderer/app/use-window-drag';

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
});
