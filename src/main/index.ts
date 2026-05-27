import './proxy-runtime';
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  globalShortcut,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  type ProcessMetric
} from 'electron';
import { join } from 'node:path';
import { createAppServices } from './services/app-service';
import { registerIpc } from './ipc/register-ipc';
import type { RuntimeMetricsProvider, RuntimeProcessMetric } from './services/diagnostics-service';
import type { SafeStorageBackend } from './services/secret-service';
import { WindowsHostService } from './windows-host-service';
import {
  buildFloatingWindowOptions,
  buildMainWindowOptions,
  getWindowBounds,
  resolveFloatingWindowBounds,
  resolveMainWindowBounds
} from './window-shell';
import {
  readWindowPlacementSnapshot,
  writeWindowPlacementSnapshot,
  type WindowPlacementSnapshot
} from './window-state-store';
import { applyWindowMaterial } from './window-material';
import { broadcastToWindows, sendToWindow } from './window-messaging';
import { bindNativeContextMenu } from './native-context-menu';
import { buildSystemAppearanceSnapshot } from './system-appearance';

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
let activeServices: ReturnType<typeof createAppServices> | null = null;
let powerResumeBound = false;
let screenBoundsBound = false;
let systemAppearanceBound = false;
let appShutdownApplied = false;

const hostService = new WindowsHostService({
  app: {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    setAppUserModelId: (id) => {
      app.setAppUserModelId(id);
    },
    on: (event, listener) => {
      if (event === 'before-quit') {
        app.on('before-quit', listener);
        return;
      }
      app.on('second-instance', listener);
    },
    quit: () => {
      app.quit();
    },
    setLoginItemSettings: (settings) => {
      app.setLoginItemSettings(settings);
    },
    getLoginItemSettings: () => app.getLoginItemSettings()
  },
  globalShortcut,
  lifecycleService: {
    getTraySummary: () => {
      if (activeServices !== null) {
        return activeServices.lifecycleService.getTraySummary();
      }
      return {
        residentEnabled: true,
        backgroundPaused: false,
        backgroundTasks: {
          total: 0,
          running: 0,
          failed: 0,
          pendingConfirmation: 0,
          nextRunAt: null
        },
        nextRunAt: null,
        updatedAt: new Date().toISOString()
      };
    },
    pauseBackgroundExecution: () => {
      if (activeServices === null) {
        throw new Error('Lifecycle service is not ready.');
      }
      return activeServices.lifecycleService.pauseBackgroundExecution();
    },
    resumeBackgroundExecution: () => {
      if (activeServices === null) {
        throw new Error('Lifecycle service is not ready.');
      }
      return activeServices.lifecycleService.resumeBackgroundExecution();
    }
  },
  logService: {
    append: (event) => {
      if (activeServices === null) {
        console.log(JSON.stringify(event));
        return;
      }
      activeServices.logService.append(event);
    }
  },
  menu: Menu,
  createTray: (iconDataUrl) => {
    const tray = new Tray(nativeImage.createFromDataURL(iconDataUrl).resize({ width: 16, height: 16 }));
    return {
      setToolTip: (tooltip) => {
        tray.setToolTip(tooltip);
      },
      setContextMenu: (menu) => {
        tray.setContextMenu(menu as Menu | null);
      },
      on: (event, handler) => {
        tray.on(event, () => {
          void handler();
        });
      },
      destroy: () => {
        tray.destroy();
      }
    };
  },
  openMainPage: showMainPage,
  openQuickEntry: () => openFloatingEntry('quick'),
  openTrayEntry: () => openFloatingEntry('tray'),
  broadcastTaskUpdated: () => {
    broadcastToWindows([mainWindow, quickEntryWindow, trayEntryWindow], 'roc:tasks:updated', null);
  }
});

const ownsSingleInstanceLock = hostService.initializeProcessIdentity();

app.on('before-quit', () => {
  if (appShutdownApplied) {
    return;
  }
  appShutdownApplied = true;
  activeServices?.appService.shutdown();
  activeServices = null;
});

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
  if (activeServices === null) {
    throw new Error('App services are not ready for floating entry windows.');
  }
  const existingWindow = kind === 'quick' ? quickEntryWindow : trayEntryWindow;
  if (existingWindow !== null && !existingWindow.isDestroyed()) {
    existingWindow.show();
    existingWindow.focus();
    return;
  }

  const currentDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const entryWindow = new BrowserWindow(
    buildFloatingWindowOptions(
      preloadPath,
      kind === 'quick' ? 'Roc Quick Entry' : 'Roc Tray Status',
      resolveFloatingWindowBounds(kind, { workArea: currentDisplay.workArea })
    )
  );
  applyWindowMaterial(entryWindow, 'acrylic', activeServices.logService);
  entryWindow.setMenuBarVisibility(false);
  entryWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  bindNativeContextMenu(entryWindow.webContents);
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
  if (!ownsSingleInstanceLock) {
    return;
  }
  const services = createAppServices(
    process.env.ROC_DATA_ROOT,
    {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      getAppearance: getSystemAppearanceSnapshot
    },
    createElectronSafeStorageBackend(),
    createElectronRuntimeMetricsProvider()
  );
  activeServices = services;
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
  const windowStateFilePath = join(services.paths.configDir, 'window-state.json');
  const restoredPlacement = readWindowPlacementSnapshot(windowStateFilePath);
  const restoredBounds = resolveMainWindowBounds(
    restoredPlacement === null ? null : restoredPlacement.bounds,
    getDisplayWorkAreas()
  );
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
    new BrowserWindow(buildMainWindowOptions(preloadPath, restoredBounds))
  );
  applyWindowMaterial(mainWindow, 'mica', services.logService);
  if (restoredPlacement !== null && restoredPlacement.maximized) {
    mainWindow.maximize();
  }
  bindWindowPlacementPersistence(mainWindow, windowStateFilePath);
  bindDisplayBoundsCorrection();
  bindSystemAppearanceBroadcast();
  hostService.bindMainWindow(mainWindow);
  hostService.syncSettings(services.configService.getSettings());
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  registerIpc(services, mainWindow, {
    openMainPage: showMainPage,
    openQuickEntry: () => openFloatingEntry('quick'),
    openTrayEntry: () => openFloatingEntry('tray'),
    closeMainWindow: () => {
      mainWindow?.close();
    },
    syncHostSettings: (settings) => {
      hostService.syncSettings(settings);
    },
    getHostIntegrationStatus: () => hostService.getIntegrationStatus(),
    broadcastTaskUpdated: (event) => {
      hostService.refreshTray();
      broadcastToWindows([mainWindow, quickEntryWindow, trayEntryWindow], 'roc:tasks:updated', event ?? null);
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
  if (!powerResumeBound) {
    powerResumeBound = true;
    powerMonitor.on('resume', () => {
      activeServices?.taskSchedulerService.handlePowerResume();
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  bindNativeContextMenu(mainWindow.webContents);

  let mainWindowShown = false;
  function showMainWindowOnce(label: string): void {
    if (mainWindowShown) {
      return;
    }
    mainWindowShown = true;
    services.performanceObserverService.record({
      phase: 'ready_to_show',
      label,
      startedAtMs: mainReadyStartedAtMs,
      durationMs: performance.now() - mainReadyStartedAtMs,
      metadata: {
        window: 'main'
      }
    });
    mainWindow?.show();
    initializeDeferredServices();
  }

  mainWindow.once('ready-to-show', () => {
    showMainWindowOnce('mainWindow.ready-to-show');
  });
  mainWindow.webContents.once('did-finish-load', () => {
    showMainWindowOnce('mainWindow.did-finish-load');
  });

  await services.performanceObserverService.measureAsync('renderer_loaded', 'mainWindow.loadRenderer', () => loadMainRenderer(mainWindow!));
}

function bindWindowPlacementPersistence(window: BrowserWindow, filePath: string): void {
  function persistWindowPlacement(): void {
    if (window.isDestroyed()) {
      return;
    }
    const normalBounds = window.getNormalBounds();
    const snapshot: WindowPlacementSnapshot = {
      bounds: {
        x: normalBounds.x,
        y: normalBounds.y,
        width: normalBounds.width,
        height: normalBounds.height
      },
      maximized: window.isMaximized(),
      updatedAt: new Date().toISOString()
    };
    writeWindowPlacementSnapshot(filePath, snapshot);
  }

  window.on('move', persistWindowPlacement);
  window.on('moved', persistWindowPlacement);
  window.on('resize', persistWindowPlacement);
  window.on('resized', persistWindowPlacement);
  window.on('maximize', persistWindowPlacement);
  window.on('unmaximize', persistWindowPlacement);
  window.on('close', persistWindowPlacement);
}

function bindDisplayBoundsCorrection(): void {
  if (screenBoundsBound) {
    return;
  }
  screenBoundsBound = true;
  const correctBounds = (): void => {
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.isMaximized()) {
      return;
    }
    const currentBounds = getWindowBounds(mainWindow);
    const nextBounds = resolveMainWindowBounds(currentBounds, getDisplayWorkAreas());
    if (
      nextBounds.x === currentBounds.x &&
      nextBounds.y === currentBounds.y &&
      nextBounds.width === currentBounds.width &&
      nextBounds.height === currentBounds.height
    ) {
      return;
    }
    mainWindow.setBounds(nextBounds);
  };
  screen.on('display-added', correctBounds);
  screen.on('display-removed', correctBounds);
  screen.on('display-metrics-changed', correctBounds);
}

function bindSystemAppearanceBroadcast(): void {
  if (systemAppearanceBound) {
    return;
  }
  systemAppearanceBound = true;
  const broadcastSystemAppearance = (): void => {
    broadcastToWindows([mainWindow, quickEntryWindow, trayEntryWindow], 'roc:appearance:updated', getSystemAppearanceSnapshot());
  };
  nativeTheme.on('updated', broadcastSystemAppearance);
  systemPreferences.on('color-changed', broadcastSystemAppearance);
}

function getSystemAppearanceSnapshot() {
  return buildSystemAppearanceSnapshot({
    nativeTheme,
    systemPreferences
  });
}

function getDisplayWorkAreas(): Array<{ workArea: { x: number; y: number; width: number; height: number } }> {
  return screen.getAllDisplays().map((display) => ({
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    }
  }));
}

if (!ownsSingleInstanceLock) {
  app.exit(0);
} else {
  app.whenReady().then(createWindow).catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
}

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

function createElectronRuntimeMetricsProvider(): RuntimeMetricsProvider {
  return {
    getBrowserWindowCount: () => BrowserWindow.getAllWindows().length,
    getProcessMetrics: () => app.getAppMetrics().map(toRuntimeProcessMetric)
  };
}

function toRuntimeProcessMetric(metric: ProcessMetric): RuntimeProcessMetric {
  return {
    pid: metric.pid,
    type: metric.type,
    name: metric.name,
    serviceName: metric.serviceName,
    cpuPercent: metric.cpu.percentCPUUsage,
    sandboxed: metric.sandboxed,
    integrityLevel: metric.integrityLevel,
    memory: {
      workingSetSizeKb: metric.memory.workingSetSize,
      peakWorkingSetSizeKb: metric.memory.peakWorkingSetSize,
      privateBytesKb: metric.memory.privateBytes
    }
  };
}
