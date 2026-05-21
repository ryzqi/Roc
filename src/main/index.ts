import './proxy-runtime';
import { BrowserWindow, Menu, app, protocol, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { createAppServices } from './services/app-service';
import { registerIpc } from './ipc/register-ipc';
import type { SafeStorageBackend } from './services/secret-service';
import { buildFloatingWindowOptions, buildMainWindowOptions } from './window-shell';
import { broadcastToWindows, sendToWindow } from './window-messaging';

const isDevelopment = !app.isPackaged;
const preloadPath = join(__dirname, '../preload/index.mjs');
const mainReadyStartedAtMs = performance.now();
const pdfPreviewScheme = 'roc-preview';
let pdfPreviewServices: ReturnType<typeof createAppServices> | null = null;
let pdfPreviewProtocolRegistered = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: pdfPreviewScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

let mainWindow: BrowserWindow | null = null;
let quickEntryWindow: BrowserWindow | null = null;
let trayEntryWindow: BrowserWindow | null = null;

async function loadMainRenderer(window: BrowserWindow): Promise<void> {
  if (isDevelopment && process.env.ELECTRON_RENDERER_URL !== undefined) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    return;
  }
  await window.loadFile(join(__dirname, '../renderer/index.html'));
}

async function loadFloatingRenderer(window: BrowserWindow, kind: 'quick' | 'tray'): Promise<void> {
  const pagePath = kind === 'quick' ? 'quick-entry.html' : 'tray-entry.html';
  if (isDevelopment && process.env.ELECTRON_RENDERER_URL !== undefined) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.pathname = `/${pagePath}`;
    url.searchParams.set('page', kind);
    await window.loadURL(url.toString());
    return;
  }
  await window.loadFile(join(__dirname, `../renderer/${pagePath}`), { query: { page: kind } });
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

  await loadFloatingRenderer(entryWindow, kind);
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
  pdfPreviewServices = services;
  services.performanceObserverService.record({
    phase: 'main_ready',
    label: 'app.whenReady',
    startedAtMs: mainReadyStartedAtMs,
    durationMs: performance.now() - mainReadyStartedAtMs,
    metadata: {
      packaged: app.isPackaged
    }
  });
  services.performanceObserverService.measure('services_critical_initialized', 'appService.initializeCritical', () => {
    services.appService.initializeCritical();
  });
  let deferredInitialized = false;
  function initializeDeferredServices(): void {
    if (deferredInitialized) {
      return;
    }
    deferredInitialized = true;
    setImmediate(() => {
      try {
        services.performanceObserverService.measure('services_deferred_initialized', 'appService.initializeDeferred', () => {
          services.appService.initializeDeferred();
        });
      } catch (error) {
        services.logService.append({
          level: 'error',
          message: 'Roc deferred services failed to initialize.',
          data: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });
  }

  mainWindow = services.performanceObserverService.measure('window_created', 'mainWindow', () =>
    new BrowserWindow(buildMainWindowOptions(preloadPath))
  );
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
  if (!pdfPreviewProtocolRegistered) {
    protocol.handle(pdfPreviewScheme, (request) => {
      const activeServices = pdfPreviewServices;
      if (activeServices === null) {
        return new Response('Preview service unavailable', { status: 503 });
      }
      const url = new URL(request.url);
      if (url.hostname !== 'workspace' || !url.pathname.startsWith('/pdf/')) {
        return new Response('Not found', { status: 404 });
      }
      const relativePath = url.pathname.slice('/pdf/'.length);
      return activeServices.fileService.streamPdfPreviewResource(relativePath);
    });
    pdfPreviewProtocolRegistered = true;
  }

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
    services.performanceObserverService.record({
      phase: 'ready_to_show',
      label: 'mainWindow.ready-to-show',
      startedAtMs: mainReadyStartedAtMs,
      durationMs: performance.now() - mainReadyStartedAtMs,
      metadata: {
        window: 'main'
      }
    });
    mainWindow?.show();
    initializeDeferredServices();
  });

  await services.performanceObserverService.measureAsync('renderer_loaded', 'mainWindow.loadRenderer', () => loadMainRenderer(mainWindow!));
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
