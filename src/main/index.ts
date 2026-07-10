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
  screen,
  shell,
  systemPreferences
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcChannels } from '../shared/ipc';
import type { ChatRunEvent, TaskUpdateEvent, TerminalSessionExitEvent, TerminalSessionOutputEvent, TraySummary, WorkspaceChangedEvent } from '../shared/types';
import { registerIpc } from './ipc/register-ipc';
import { createMainKernelBootstrap, type MainKernelBootstrap } from './main-kernel-bootstrap';
import { agentChatRunEventType } from './plugins/agent/runtime';
import { workspaceChangedEventType } from './plugins/workspace';
import {
  terminalSessionExitEventType,
  terminalSessionOutputEventType
} from './plugins/workspace/terminal-capabilities';
import { PerformanceObserverService } from './services/performance-observer-service';
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
import { handleExternalNavigation } from './external-link-policy';
import {
  createElectronRuntimeMetricsProvider,
  createElectronSafeStorageBackend
} from './electron-runtime-adapters';
import { toLogError } from './services/errors';
import { registerPdfPreviewProtocol, registerPdfPreviewScheme } from './pdf-preview-protocol';

const mainModuleDir = dirname(fileURLToPath(import.meta.url));
const isDevelopment = !app.isPackaged;
const preloadPath = join(mainModuleDir, '../preload/index.cjs');
const appIconPath = isDevelopment
  ? join(mainModuleDir, '../../resources/icon.ico')
  : join(process.resourcesPath, 'icon.ico');
const mainReadyStartedAtMs = performance.now();
let pdfPreviewKernel: MainKernelBootstrap | null = null;
let pdfPreviewProtocolRegistered = false;

registerPdfPreviewScheme();

let mainWindow: BrowserWindow | null = null;
let activeKernel: MainKernelBootstrap | null = null;
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
    getTraySummary: () => requireActiveKernel().invokeCapability<{}, TraySummary>('lifecycle.getTraySummary', {}),
    pauseBackgroundExecution: () =>
      requireActiveKernel().invokeCapability<{}, TraySummary>('lifecycle.pauseBackgroundExecution', {}),
    resumeBackgroundExecution: () =>
      requireActiveKernel().invokeCapability<{}, TraySummary>('lifecycle.resumeBackgroundExecution', {})
  },
  logService: {
    info: (message, context) => {
      const kernel = activeKernel;
      if (kernel === null) {
        console.log(JSON.stringify({ ...context, level: 'info', message }));
        return;
      }
      kernel.logService.info(message, context);
    },
    warn: (message, context) => {
      const kernel = activeKernel;
      if (kernel === null) {
        console.log(JSON.stringify({ ...context, level: 'warn', message }));
        return;
      }
      kernel.logService.warn(message, context);
    },
    error: (message, error, context) => {
      const kernel = activeKernel;
      if (kernel === null) {
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
      kernel.logService.error(message, error, context);
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
  const kernel = activeKernel;
  activeKernel = null;
  pdfPreviewKernel = null;
  if (kernel === null) {
    appShutdownComplete = true;
    return;
  }
  event.preventDefault();
  appShutdownInProgress = Promise.resolve()
    .then(async () => {
      if (kernel !== null) {
        await kernel.shutdown();
      }
    })
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
  await window.loadFile(join(mainModuleDir, '../renderer/index.html'));
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

function requireActiveKernel(): MainKernelBootstrap {
  if (activeKernel === null) {
    throw new Error('Kernel is not ready.');
  }
  return activeKernel;
}

async function createWindow(): Promise<void> {
  if (!ownsSingleInstanceLock) {
    return;
  }
  const performanceObserverService = new PerformanceObserverService();
  const safeStorageBackend = createElectronSafeStorageBackend();
  const runtimeMetricsProvider = createElectronRuntimeMetricsProvider();
  const kernel = createMainKernelBootstrap({
    dataRoot: process.env.ROC_DATA_ROOT,
    getAppearance: getSystemAppearanceSnapshot,
    isPackaged: app.isPackaged,
    performanceObserverService,
    safeStorage: safeStorageBackend,
    runtimeMetricsProvider,
    version: app.getVersion()
  });
  await kernel.start();
  activeKernel = kernel;
  pdfPreviewKernel = kernel;
  kernel.performanceObserverService.record({
    phase: 'main_ready',
    label: 'app.whenReady',
    startedAtMs: mainReadyStartedAtMs,
    durationMs: performance.now() - mainReadyStartedAtMs,
    metadata: {
      packaged: app.isPackaged
    }
  });
  const windowStateFilePath = join(kernel.paths.configDir, 'window-state.json');
  const restoredPlacement = readWindowPlacementSnapshot(windowStateFilePath);
  const restoredBounds = resolveMainWindowBounds(
    restoredPlacement === null ? null : restoredPlacement.bounds,
    getDisplayWorkAreas()
  );

  mainWindow = kernel.performanceObserverService.measure('window_created', 'mainWindow', () =>
    new BrowserWindow(buildMainWindowOptions(preloadPath, appIconPath, restoredBounds))
  );
  applyWindowMaterialWithFallback(
    mainWindow,
    {
      primary: 'mica',
      fallbacks: ['acrylic'],
      staticBackground: mainWindowStaticBackground
    },
    kernel.logService
  );
  if (restoredPlacement !== null && restoredPlacement.maximized) {
    mainWindow.maximize();
  }
  bindWindowPlacementPersistence(mainWindow, windowStateFilePath);
  bindDisplayBoundsCorrection();
  bindSystemAppearanceBroadcast();
  hostService.bindMainWindow(mainWindow);
  hostService.syncSettings(kernel.configService.getSettings());
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  registerIpc(kernel, mainWindow, {
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
    registerPdfPreviewProtocol(() => pdfPreviewKernel);
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
  kernel.subscribeEvent<TerminalSessionOutputEvent>(terminalSessionOutputEventType, (event) => {
    terminalOutputBatcher.schedule(event.payload);
  });
  kernel.subscribeEvent<TerminalSessionExitEvent>(terminalSessionExitEventType, (event) => {
    terminalOutputBatcher.flush();
    broadcastToWindows([mainWindow], ipcChannels.terminalExit, event.payload, {
      include: (_window, index) => index === 0
    });
  });
  kernel.subscribeEvent<WorkspaceChangedEvent>(workspaceChangedEventType, (event) => {
    broadcastToWindows([mainWindow], ipcChannels.workspaceChanged, event.payload, {
      include: (_window, index) => index === 0
    });
  });
  kernel.subscribeEvent<ChatRunEvent>(agentChatRunEventType, (event) => {
    broadcastToWindows([mainWindow], ipcChannels.chatRunEvent, event.payload, {
      include: (_window, index) => index === 0
    });
    if (event.payload.runId.startsWith('run_') && shouldBroadcastTaskRefresh(event.payload)) {
      broadcastToWindows([mainWindow], ipcChannels.tasksUpdated, null);
    }
  });
  kernel.subscribeEvent<TaskUpdateEvent>('task.updated', (event) => {
    hostService.refreshTray();
    broadcastToWindows([mainWindow], ipcChannels.tasksUpdated, event.payload);
  });
  if (!powerResumeBound) {
    powerResumeBound = true;
    powerMonitor.on('resume', () => {
      const kernel = activeKernel;
      if (kernel === null) {
        return;
      }
      void kernel.invokeCapability<{}, { handled: true }>('task.scheduler.handlePowerResume', {})
        .then(() => {
          hostService.refreshTray();
          broadcastToWindows([mainWindow], ipcChannels.tasksUpdated, null);
        })
        .catch((error: unknown) => {
          kernel.logService.error('Task scheduler power resume handling failed.', toLogError(error), {
            service: 'main',
            component: 'powerMonitor.resume'
          });
        });
    });
  }

  const externalNavigationInput = {
    shell,
    logService: kernel.logService
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return handleExternalNavigation(url, externalNavigationInput);
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    handleExternalNavigation(url, externalNavigationInput);
  });
  bindNativeContextMenu(mainWindow.webContents);

  let mainWindowShown = false;
  function showMainWindowOnce(label: string): void {
    if (mainWindowShown) {
      return;
    }
    mainWindowShown = true;
    kernel.performanceObserverService.record({
      phase: 'ready_to_show',
      label,
      startedAtMs: mainReadyStartedAtMs,
      durationMs: performance.now() - mainReadyStartedAtMs,
      metadata: {
        window: 'main'
      }
    });
    mainWindow?.show();
  }

  mainWindow.once('ready-to-show', () => {
    showMainWindowOnce('mainWindow.ready-to-show');
  });
  mainWindow.webContents.once('did-finish-load', () => {
    showMainWindowOnce('mainWindow.did-finish-load');
  });

  await kernel.performanceObserverService.measureAsync('renderer_loaded', 'mainWindow.loadRenderer', () => loadMainRenderer(mainWindow!));
}

function shouldBroadcastTaskRefresh(event: ChatRunEvent): boolean {
  return (
    event.type === 'run_started' ||
    event.type === 'run_completed' ||
    event.type === 'run_failed' ||
    event.type === 'run_interrupted' ||
    event.type === 'run_resumed'
  );
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
