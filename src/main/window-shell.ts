import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { CHAT_WINDOW_MIN_WIDTH } from '../shared/chat-layout';
import type { WindowBoundsSnapshot, WindowHiddenSnapshot, WindowStateSnapshot } from '../shared/types';

type DisplayLike = {
  workArea: WindowBoundsSnapshot;
};

const defaultMainWindowBounds: WindowBoundsSnapshot = {
  x: 0,
  y: 0,
  width: 1320,
  height: 860
};

const minMainWindowSize = {
  width: CHAT_WINDOW_MIN_WIDTH,
  height: 640
};

export const mainWindowStaticBackground = '#00000000';

export function buildMainWindowOptions(
  preloadPath: string,
  restoredBounds: WindowBoundsSnapshot | null = null
): BrowserWindowConstructorOptions {
  const bounds = restoredBounds === null ? defaultMainWindowBounds : restoredBounds;
  return {
    x: restoredBounds === null ? undefined : bounds.x,
    y: restoredBounds === null ? undefined : bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: minMainWindowSize.width,
    minHeight: minMainWindowSize.height,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 19 },
    backgroundColor: mainWindowStaticBackground,
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    title: 'Roc',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
      v8CacheOptions: 'code'
    }
  };
}

export function resolveMainWindowBounds(
  savedBounds: WindowBoundsSnapshot | null,
  displays: DisplayLike[]
): WindowBoundsSnapshot {
  const display = findBestDisplay(savedBounds, displays);
  if (display === null) {
    return savedBounds === null ? defaultMainWindowBounds : savedBounds;
  }
  const workArea = display.workArea;
  if (savedBounds === null || getIntersectionArea(savedBounds, workArea) === 0) {
    const bounds = savedBounds === null ? defaultMainWindowBounds : savedBounds;
    return centerBounds(constrainBoundsSize(bounds, workArea), workArea);
  }
  return clampBoundsToWorkArea(constrainBoundsSize(savedBounds, workArea), workArea);
}

export function getWindowState(window: Pick<BrowserWindow, 'isMaximized' | 'isMinimized' | 'isFullScreen'>): WindowStateSnapshot {
  return {
    maximized: window.isMaximized(),
    minimized: window.isMinimized(),
    fullscreen: window.isFullScreen()
  };
}

export function getWindowHiddenState(
  window: Pick<BrowserWindow, 'isVisible' | 'isMinimized'>
): WindowHiddenSnapshot {
  return {
    hidden: window.isMinimized() || !window.isVisible()
  };
}

export type HiddenBroadcastWindow = {
  on: (event: 'hide' | 'show' | 'minimize' | 'restore', listener: () => void) => unknown;
  isVisible: () => boolean;
  isMinimized: () => boolean;
};

export function bindWindowHiddenBroadcast(
  window: HiddenBroadcastWindow,
  send: (snapshot: WindowHiddenSnapshot) => void
): void {
  const emit = (): void => {
    send(getWindowHiddenState(window));
  };
  window.on('hide', emit);
  window.on('show', emit);
  window.on('minimize', emit);
  window.on('restore', emit);
  emit();
}

export function getWindowBounds(
  window: Pick<BrowserWindow, 'getBounds'>
): WindowBoundsSnapshot {
  const bounds = window.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function findBestDisplay(savedBounds: WindowBoundsSnapshot | null, displays: DisplayLike[]): DisplayLike | null {
  if (displays.length === 0) {
    return null;
  }
  if (savedBounds === null) {
    return displays.length === 0 ? null : displays[0];
  }
  let bestDisplay = displays.length === 0 ? null : displays[0];
  let bestArea = bestDisplay === null ? 0 : getIntersectionArea(savedBounds, bestDisplay.workArea);
  for (const display of displays.slice(1)) {
    const area = getIntersectionArea(savedBounds, display.workArea);
    if (area > bestArea) {
      bestArea = area;
      bestDisplay = display;
    }
  }
  return bestArea > 0 ? bestDisplay : displays[0];
}

function getIntersectionArea(a: WindowBoundsSnapshot, b: WindowBoundsSnapshot): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) {
    return 0;
  }
  return (right - left) * (bottom - top);
}

function constrainBoundsSize(bounds: WindowBoundsSnapshot, workArea: WindowBoundsSnapshot): WindowBoundsSnapshot {
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.min(Math.max(bounds.width, minMainWindowSize.width), workArea.width),
    height: Math.min(Math.max(bounds.height, minMainWindowSize.height), workArea.height)
  };
}

function clampBoundsToWorkArea(bounds: WindowBoundsSnapshot, workArea: WindowBoundsSnapshot): WindowBoundsSnapshot {
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height),
    width: bounds.width,
    height: bounds.height
  };
}

function centerBounds(bounds: WindowBoundsSnapshot, workArea: WindowBoundsSnapshot): WindowBoundsSnapshot {
  return {
    x: Math.round(workArea.x + (workArea.width - bounds.width) / 2),
    y: Math.round(workArea.y + (workArea.height - bounds.height) / 2),
    width: bounds.width,
    height: bounds.height
  };
}
