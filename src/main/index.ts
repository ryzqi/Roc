import { BrowserWindow, Menu, app, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { createAppServices } from './services/app-service';
import { registerIpc } from './ipc/register-ipc';
import type { SafeStorageBackend } from './services/secret-service';
import { buildFloatingWindowOptions, buildMainWindowOptions } from './window-shell';
import { broadcastToWindows, sendToWindow } from './window-messaging';

const isDevelopment = !app.isPackaged;
const preloadPath = join(__dirname, '../preload/index.mjs');

let mainWindow: BrowserWindow | null = null;
let quickEntryWindow: BrowserWindow | null = null;
let trayEntryWindow: BrowserWindow | null = null;

async function loadRenderer(window: BrowserWindow, params?: URLSearchParams): Promise<void> {
  if (isDevelopment && process.env.ELECTRON_RENDERER_URL !== undefined) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    params?.forEach((value, key) => {
      url.searchParams.set(key, value);
    });
    await window.loadURL(url.toString());
    return;
  }
  await window.loadFile(join(__dirname, '../renderer/index.html'), params === undefined ? undefined : { query: Object.fromEntries(params) });
}

function showMainPage(page: string): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  sendToWindow(mainWindow, 'roc:navigate', page);
}

async function openFloatingEntry(kind: 'quick' | 'tray'): Promise<void> {
  const existingWindow = kind === 'quick' ? quickEntryWindow : trayEntryWindow;
  if (existingWindow !== null && !existingWindow.isDestroyed()) {
    existingWindow.show();
    existingWindow.focus();
    return;
  }

  const entryWindow = new BrowserWindow(
    buildFloatingWindowOptions(preloadPath, kind === 'quick' ? 'Roc Quick Entry' : 'Roc Tray Status')
  );
  entryWindow.setMenuBarVisibility(false);
  entryWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  entryWindow.once('ready-to-show', () => {
    entryWindow.show();
  });
  entryWindow.on('closed', () => {
    if (kind === 'quick') {
      quickEntryWindow = null;
    } else {
      trayEntryWindow = null;
    }
  });

  if (kind === 'quick') {
    quickEntryWindow = entryWindow;
  } else {
    trayEntryWindow = entryWindow;
  }

  await loadRenderer(entryWindow, new URLSearchParams({ page: kind }));
}

async function createWindow(): Promise<void> {
  const services = createAppServices(
    process.env.ROC_DATA_ROOT,
    {
      version: app.getVersion(),
      isPackaged: app.isPackaged
    },
    createElectronSafeStorageBackend()
  );
  services.appService.initialize();

  mainWindow = new BrowserWindow(buildMainWindowOptions(preloadPath));
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  registerIpc(services, mainWindow, {
    openMainPage: showMainPage,
    openQuickEntry: () => openFloatingEntry('quick'),
    openTrayEntry: () => openFloatingEntry('tray'),
    broadcastTaskUpdated: () => {
      broadcastToWindows([mainWindow, quickEntryWindow, trayEntryWindow], 'roc:tasks:updated', null);
    }
  });

  services.terminalSessionService.onOutput((event) => {
    broadcastToWindows([mainWindow, quickEntryWindow, trayEntryWindow], 'roc:terminal:output', event);
  });
  services.terminalSessionService.onExit((event) => {
    broadcastToWindows([mainWindow, quickEntryWindow, trayEntryWindow], 'roc:terminal:exit', event);
  });
  services.deepAgentRuntimeService.onRunEvent((event) => {
    broadcastToWindows([mainWindow, quickEntryWindow, trayEntryWindow], 'roc:chat:run-event', event);
    if (event.runId.startsWith('run_')) {
      broadcastToWindows([mainWindow, quickEntryWindow, trayEntryWindow], 'roc:tasks:updated', null);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  await loadRenderer(mainWindow);
}

app.whenReady().then(createWindow).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function createElectronSafeStorageBackend(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plaintext) => safeStorage.encryptString(plaintext),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted)
  };
}
