import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { WindowStateSnapshot } from '../shared/types';

export function buildMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1320,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f8f5',
    title: 'Roc Windows Super Assistant',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };
}

export function buildFloatingWindowOptions(preloadPath: string, title: string): BrowserWindowConstructorOptions {
  const isQuick = title === 'Roc Quick Entry';
  return {
    width: isQuick ? 760 : 360,
    height: isQuick ? 470 : 450,
    minWidth: 420,
    minHeight: 300,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    resizable: false,
    backgroundColor: '#f7f8f5',
    title,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };
}

export function getWindowState(window: Pick<BrowserWindow, 'isMaximized' | 'isMinimized' | 'isFullScreen'>): WindowStateSnapshot {
  return {
    maximized: window.isMaximized(),
    minimized: window.isMinimized(),
    fullscreen: window.isFullScreen()
  };
}
