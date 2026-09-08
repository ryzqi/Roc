import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { bindWindowPlacementPersistence, readWindowPlacementSnapshot } from '../../src/main/window-state-store';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), 'roc-window-persistence-'));
  roots.push(root);
  const filePath = join(root, 'window-state.json');
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    getNormalBounds: vi.fn(() => ({ x: 80, y: 50, width: 1320, height: 860 })),
    isMaximized: vi.fn(() => false)
  });
  bindWindowPlacementPersistence(window as unknown as BrowserWindow, filePath);
  return { window, filePath };
}

describe('window placement persistence', () => {
  it('coalesces dragging events and saves the latest bounds after the drag pauses', () => {
    const { window, filePath } = setup();
    for (let index = 0; index < 100; index += 1) {
      window.emit('move');
      window.emit('resize');
      vi.advanceTimersByTime(10);
    }
    expect(readWindowPlacementSnapshot(filePath)).toBeNull();
    expect(window.getNormalBounds).not.toHaveBeenCalled();
    window.getNormalBounds.mockReturnValue({ x: 120, y: 90, width: 1400, height: 900 });
    vi.advanceTimersByTime(200);
    expect(window.getNormalBounds).toHaveBeenCalledTimes(1);
    expect(readWindowPlacementSnapshot(filePath)?.bounds).toEqual({ x: 120, y: 90, width: 1400, height: 900 });
  });

  it('flushes before close and skips duplicate moved or resized writes', () => {
    const { window, filePath } = setup();
    window.emit('resize');
    window.emit('close');
    const saved = readWindowPlacementSnapshot(filePath);
    expect(saved?.bounds.width).toBe(1320);
    vi.advanceTimersByTime(500);
    window.emit('moved');
    window.emit('resized');
    expect(readWindowPlacementSnapshot(filePath)).toEqual(saved);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending work when the window is destroyed', () => {
    const { window, filePath } = setup();
    window.emit('resize');
    window.isDestroyed.mockReturnValue(true);
    window.emit('closed');
    vi.advanceTimersByTime(500);
    expect(window.getNormalBounds).not.toHaveBeenCalled();
    expect(readWindowPlacementSnapshot(filePath)).toBeNull();
  });
});
