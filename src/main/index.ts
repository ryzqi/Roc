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
import { ipcChannels } from '../shared/ipc';
import { createAppServices } from './services/app-service';
import { registerIpc } from './ipc/register-ipc';
import type { RuntimeMetricsProvider, RuntimeProcessMetric } from './services/diagnostics-service';
import type { SafeStorageBackend } from './services/secret-service';
import { WindowsHostService } from './windows-host-service';
import {
  buildMainWindowOptions,
  getWindowBounds,
  mainWindowStaticBackground,
  resolveMainWindowBounds
} from './window-shell';
import {
  readWindowPlacementSnapshot,
  writeWindowPlacementSnapshot,
  type WindowPlacementSnapshot
} from './window-state-store';
import { applyWindowMaterialWithFallback } from './window-material';
import { broadcastToWindows, sendToWindow } from './window-messaging';
import { createTerminalOutputBatcher } from './terminal-output-batcher';
import { bindNativeContextMenu } from './native-context-menu';
import { buildSystemAppearanceSnapshot } from './system-appearance';
import { handleExternalWindowOpen } from './external-link-policy';

const isDevelopment = !app.isPackaged;
const preloadPath = join(__dirname, '../preload/index.mjs');
const appIconPath = isDevelopment
  ? join(__dirname, '../../resources/icon.ico')
  : join(process.resourcesPath, 'icon.ico');
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
let activeServices: ReturnType<typeof createAppServices> | null = null;
let powerResumeBound = false;
let screenBoundsBound = false;
let systemAppearanceBound = false;
let appShutdownComplete = false;
let appShutdownInProgress: Promise<void> | null = null;

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
    info: (message, context) => {
      if (activeServices === null) {
        console.log(JSON.stringify({ ...context, level: 'info', message }));
        return;
      }
      activeServices.logService.info(message, context);
    },
    warn: (message, context) => {
      if (activeServices === null) {
        console.log(JSON.stringify({ ...context, level: 'warn', message }));
        return;
      }
      activeServices.logService.warn(message, context);
    },
    error: (message, error, context) => {
      if (activeServices === null) {
        console.log(JSON.stringify({
          ...context,
          level: 'error',
          message,
          error: {
            code: 'error',
            message: error.message,
            stack: error.stack
          }
        }));
        return;
      }
      activeServices.logService.error(message, error, context);
    }
  },
  menu: Menu,
  trayIconPath: appIconPath,
  createTray: (iconPath) => {
    const trayImage = nativeImage.createFromPath(iconPath);
    if (trayImage.isEmpty()) {
      throw new Error(`Failed to load tray icon from ${iconPath}.`);
    }
    const tray = new Tray(trayImage.resize({ width: 16, height: 16 }));
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
  broadcastTaskUpdated: () => {
    broadcastToWindows([mainWindow], ipcChannels.tasksUpdated, null);
  }
});

const ownsSingleInstanceLock = hostService.initializeProcessIdentity();

app.on('before-quit', (event) => {
  if (appShutdownComplete) {
    return;
  }
  if (appShutdownInProgress !== null) {
    event.preventDefault();
    return;
  }
  const services = activeServices;
  activeServices = null;
  if (services === null) {
    appShutdownComplete = true;
    return;
  }
  event.preventDefault();
  appShutdownInProgress = services.appService
    .shutdown()
    .catch((error: unknown) => {
      console.error(error);
    })
    .finally(() => {
      appShutdownComplete = true;
      appShutdownInProgress = null;
      app.quit();
    });
});

async function loadMainRenderer(window: BrowserWindow): Promise<void> {
  if (isDevelopment && process.env.ELECTRON_RENDERER_URL !== undefined) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    return;
  }
  await window.loadFile(join(__dirname, '../renderer/index.html'));
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
  sendToWindow(mainWindow, ipcChannels.navigate, page);
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
        services.logService.error('Roc deferred services failed to initialize.', toLogError(error), {
          service: 'main',
          component: 'initializeDeferredServices'
        });
      }
    });
  }

  mainWindow = services.performanceObserverService.measure('window_created', 'mainWindow', () =>
    new BrowserWindow(buildMainWindowOptions(preloadPath, appIconPath, restoredBounds))
  );
  applyWindowMaterialWithFallback(
    mainWindow,
    {
      primary: 'mica',
      fallbacks: ['acrylic'],
      staticBackground: mainWindowStaticBackground
    },
    services.logService
  );
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
    closeMainWindow: () => {
      mainWindow?.close();
    },
    syncHostSettings: (settings) => {
      hostService.syncSettings(settings);
    },
    getHostIntegrationStatus: () => hostService.getIntegrationStatus(),
    broadcastTaskUpdated: (event) => {
      hostService.refreshTray();
      broadcastToWindows([mainWindow], ipcChannels.tasksUpdated, event ?? null);
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

  const terminalOutputBatcher = createTerminalOutputBatcher({
    intervalMs: 16,
    send: (event) => {
      broadcastToWindows([mainWindow], ipcChannels.terminalOutput, event, {
        include: (_window, index) => index === 0
      });
    }
  });
  services.terminalSessionService.onOutput((event) => {
    terminalOutputBatcher.schedule(event);
  });
  services.terminalSessionService.onExit((event) => {
    terminalOutputBatcher.flush();
    broadcastToWindows([mainWindow], ipcChannels.terminalExit, event, {
      include: (_window, index) => index === 0
    });
  });
  services.deepAgentRuntimeService.onRunEvent((event) => {
    broadcastToWindows([mainWindow], ipcChannels.chatRunEvent, event, {
      include: (_window, index) => index === 0
    });
    if (event.runId.startsWith('run_')) {
      broadcastToWindows([mainWindow], ipcChannels.tasksUpdated, null);
    }
  });
  if (!powerResumeBound) {
    powerResumeBound = true;
    powerMonitor.on('resume', () => {
      activeServices?.taskSchedulerService.handlePowerResume();
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return handleExternalWindowOpen(url, {
      shell,
      logService: services.logService
    });
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
    broadcastToWindows([mainWindow], ipcChannels.appearanceUpdated, getSystemAppearanceSnapshot());
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

function toLogError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
