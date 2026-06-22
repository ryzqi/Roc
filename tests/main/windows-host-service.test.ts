import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../src/shared/types';
import { WindowsHostService } from '../../src/main/windows-host-service';

type WindowEvent = 'close';
type AppEvent = 'before-quit' | 'second-instance';
type TrayEvent = 'click';
const trayIconPath = 'C:/roc/resources/icon.ico';

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    schemaVersion: 2,
    defaultWorkspace: null,
    startup: {
      openAtLogin: false,
      minimizeToTray: true,
      ...overrides.startup
    },
    notifications: {
      lowDistraction: true,
      ...overrides.notifications
    },
    globalHotkey: overrides.globalHotkey ?? null,
    memory: {
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      securityScan: {
        promptInjection: true,
        credential: true,
        sshBackdoor: true,
        invisibleUnicode: true
      },
      ...overrides.memory
    },
    tasks: {
      longRunningThresholds: {
        runningSeconds: 90,
        toolCallCount: 8,
        subagentCount: 1,
        ...overrides.tasks?.longRunningThresholds
      },
      scheduler: {
        catchUpOnStartup: true,
        maxRegisteredTasks: 256,
        ...overrides.tasks?.scheduler
      }
    }
  };
}

function createAppMock(options: { singleInstanceLock?: boolean; loginItemOpenAtLogin?: boolean } = {}) {
  const handlers = new Map<AppEvent, (...args: unknown[]) => void>();
  return {
    handlers,
    requestSingleInstanceLock: vi.fn(() => options.singleInstanceLock ?? true),
    setAppUserModelId: vi.fn(),
    on: vi.fn((event: AppEvent, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    quit: vi.fn(),
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: options.loginItemOpenAtLogin ?? false
    }))
  };
}

function createWindowMock(options: { minimized?: boolean } = {}) {
  const handlers = new Map<WindowEvent, (event: { preventDefault: () => void }) => void>();
  return {
    handlers,
    on: vi.fn((event: WindowEvent, handler: (event: { preventDefault: () => void }) => void) => {
      handlers.set(event, handler);
    }),
    isMinimized: vi.fn(() => options.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn()
  };
}

function createTrayMock() {
  const handlers = new Map<TrayEvent, () => void>();
  return {
    handlers,
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn((event: TrayEvent, handler: () => void) => {
      handlers.set(event, handler);
    }),
    destroy: vi.fn()
  };
}

function createLogServiceMock() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

describe('WindowsHostService', () => {
  it('configures AppUserModelID, keeps single-instance ownership, and focuses the existing window on second-instance', async () => {
    const app = createAppMock({ singleInstanceLock: true });
    const mainWindow = createWindowMock({ minimized: true });
    const logService = createLogServiceMock();
    const tray = createTrayMock();
    const host = new WindowsHostService({
      app,
      globalShortcut: {
        register: vi.fn(() => true),
        unregister: vi.fn(),
        unregisterAll: vi.fn()
      },
      lifecycleService: {
        getTraySummary: vi.fn(() => ({
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
          updatedAt: '2026-05-27T00:00:00.000Z'
        })),
        pauseBackgroundExecution: vi.fn(),
        resumeBackgroundExecution: vi.fn()
      },
      logService,
      menu: {
        buildFromTemplate: vi.fn((template) => template)
      },
      trayIconPath,
      createTray: vi.fn(() => tray),
      openMainPage: vi.fn(),
      broadcastTaskUpdated: vi.fn()
    });

    host.bindMainWindow(mainWindow);

    expect(host.initializeProcessIdentity()).toBe(true);
    expect(app.setAppUserModelId).toHaveBeenCalledWith('com.roc.desktop');

    const secondInstanceHandler = app.handlers.get('second-instance');
    if (secondInstanceHandler === undefined) {
      throw new Error('second-instance handler was not registered.');
    }

    await secondInstanceHandler({}, ['C:\\Program Files\\Roc\\Roc.exe', 'roc://open/tasks']);

    expect(mainWindow.restore).toHaveBeenCalledTimes(1);
    expect(mainWindow.show).toHaveBeenCalledTimes(1);
    expect(mainWindow.focus).toHaveBeenCalledTimes(1);
    expect(logService.info).toHaveBeenCalledWith('Roc received second-instance launch arguments.', {
      service: 'windows-host',
      component: 'initializeProcessIdentity',
      metadata: {
        argv: ['roc://open/tasks']
      }
    });
  });

  it('hides the main window on close when minimizeToTray is enabled, but explicit quit bypasses tray residency', () => {
    const app = createAppMock();
    const mainWindow = createWindowMock();
    const host = new WindowsHostService({
      app,
      globalShortcut: {
        register: vi.fn(() => true),
        unregister: vi.fn(),
        unregisterAll: vi.fn()
      },
      lifecycleService: {
        getTraySummary: vi.fn(() => ({
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
          updatedAt: '2026-05-27T00:00:00.000Z'
        })),
        pauseBackgroundExecution: vi.fn(),
        resumeBackgroundExecution: vi.fn()
      },
      logService: createLogServiceMock(),
      menu: {
        buildFromTemplate: vi.fn((template) => template)
      },
      trayIconPath,
      createTray: vi.fn(() => createTrayMock()),
      openMainPage: vi.fn(),
      broadcastTaskUpdated: vi.fn()
    });

    host.syncSettings(createSettings({ startup: { openAtLogin: false, minimizeToTray: true } }));
    host.bindMainWindow(mainWindow);

    const closeHandler = mainWindow.handlers.get('close');
    if (closeHandler === undefined) {
      throw new Error('close handler was not registered.');
    }

    const preventDefault = vi.fn();
    closeHandler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mainWindow.hide).toHaveBeenCalledTimes(1);

    host.requestQuit();
    expect(app.quit).toHaveBeenCalledTimes(1);

    const preventDefaultAfterQuit = vi.fn();
    closeHandler({ preventDefault: preventDefaultAfterQuit });

    expect(preventDefaultAfterQuit).not.toHaveBeenCalled();
  });

  it('lets the main window close when minimizeToTray is disabled', () => {
    const mainWindow = createWindowMock();
    const host = new WindowsHostService({
      app: createAppMock(),
      globalShortcut: {
        register: vi.fn(() => true),
        unregister: vi.fn(),
        unregisterAll: vi.fn()
      },
      lifecycleService: {
        getTraySummary: vi.fn(() => ({
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
          updatedAt: '2026-05-27T00:00:00.000Z'
        })),
        pauseBackgroundExecution: vi.fn(),
        resumeBackgroundExecution: vi.fn()
      },
      logService: createLogServiceMock(),
      menu: {
        buildFromTemplate: vi.fn((template) => template)
      },
      trayIconPath,
      createTray: vi.fn(() => createTrayMock()),
      openMainPage: vi.fn(),
      broadcastTaskUpdated: vi.fn()
    });

    host.syncSettings(createSettings({ startup: { openAtLogin: false, minimizeToTray: false } }));
    host.bindMainWindow(mainWindow);
    const closeHandler = mainWindow.handlers.get('close');
    if (closeHandler === undefined) {
      throw new Error('close handler was not registered.');
    }
    const preventDefault = vi.fn();

    closeHandler({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(mainWindow.hide).not.toHaveBeenCalled();
  });

  it('syncs open-at-login and global hotkey state, and wires tray actions to lifecycle callbacks', async () => {
    const app = createAppMock({ loginItemOpenAtLogin: true });
    const pauseBackgroundExecution = vi.fn(() => ({
      residentEnabled: true,
      backgroundPaused: true,
      backgroundTasks: {
        total: 1,
        running: 0,
        failed: 0,
        pendingConfirmation: 0,
        nextRunAt: null
      },
      nextRunAt: null,
      updatedAt: '2026-05-27T00:00:00.000Z'
    }));
    const resumeBackgroundExecution = vi.fn(() => ({
      residentEnabled: true,
      backgroundPaused: false,
      backgroundTasks: {
        total: 1,
        running: 1,
        failed: 0,
        pendingConfirmation: 0,
        nextRunAt: '2026-05-28T00:00:00.000Z'
      },
      nextRunAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-27T00:00:00.000Z'
    }));
    const openMainPage = vi.fn();
    const registerHotkey = vi.fn<(accelerator: string, callback: () => void) => boolean>(() => true);
    const tray = createTrayMock();
    const createTray = vi.fn(() => tray);
    const menu = {
      buildFromTemplate: vi.fn((template) => template)
    };
    const broadcastTaskUpdated = vi.fn();
    const host = new WindowsHostService({
      app,
      globalShortcut: {
        register: registerHotkey,
        unregister: vi.fn(),
        unregisterAll: vi.fn()
      },
      lifecycleService: {
        getTraySummary: vi.fn(() => ({
          residentEnabled: true,
          backgroundPaused: false,
          backgroundTasks: {
            total: 1,
            running: 1,
            failed: 0,
            pendingConfirmation: 0,
            nextRunAt: '2026-05-28T00:00:00.000Z'
          },
          nextRunAt: '2026-05-28T00:00:00.000Z',
          updatedAt: '2026-05-27T00:00:00.000Z'
        })),
        pauseBackgroundExecution,
        resumeBackgroundExecution
      },
      logService: createLogServiceMock(),
      menu,
      trayIconPath,
      createTray,
      openMainPage,
      broadcastTaskUpdated
    });

    host.syncSettings(createSettings({ startup: { openAtLogin: true, minimizeToTray: true }, globalHotkey: 'Ctrl+Alt+R' }));

    expect(app.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        openAtLogin: true,
        enabled: true,
        args: [],
        name: 'com.roc.desktop'
      })
    );
    expect(host.getIntegrationStatus()).toEqual({
      startup: {
        configuredOpenAtLogin: true,
        effectiveOpenAtLogin: true,
        syncError: null
      },
      globalHotkey: {
        accelerator: 'Ctrl+Alt+R',
        registered: true,
        registrationError: null
      }
    });
    expect(createTray).toHaveBeenCalledWith(trayIconPath);

    const template = menu.buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{ label?: string; click?: () => void }>;
    expect(template.map((item) => item.label).filter(Boolean)).not.toContain('快速入口');
    const pauseItem = template.find((item) => item.label === '暂停后台执行');
    if (pauseItem?.click === undefined) {
      throw new Error('pause tray item was not built.');
    }

    pauseItem.click();
    expect(pauseBackgroundExecution).toHaveBeenCalledTimes(1);
    expect(broadcastTaskUpdated).toHaveBeenCalledTimes(1);

    const trayClickHandler = tray.handlers.get('click');
    if (trayClickHandler === undefined) {
      throw new Error('tray click handler was not registered.');
    }

    await trayClickHandler();
    expect(openMainPage).toHaveBeenCalledWith('chat');

    const hotkeyCallback = registerHotkey.mock.calls.at(-1)?.[1];
    if (hotkeyCallback === undefined) {
      throw new Error('global hotkey callback was not registered.');
    }
    hotkeyCallback();
    expect(openMainPage).toHaveBeenCalledWith('chat');
  });

  it('updates tray state from async kernel lifecycle callbacks', async () => {
    const app = createAppMock();
    const tray = createTrayMock();
    const menu = {
      buildFromTemplate: vi.fn((template) => template)
    };
    const broadcastTaskUpdated = vi.fn();
    const pauseBackgroundExecution = vi.fn(async () => ({
      residentEnabled: true,
      backgroundPaused: true,
      backgroundTasks: {
        total: 1,
        running: 0,
        failed: 0,
        pendingConfirmation: 0,
        nextRunAt: null
      },
      nextRunAt: null,
      updatedAt: '2026-06-05T00:00:00.000Z'
    }));
    const host = new WindowsHostService({
      app,
      globalShortcut: {
        register: vi.fn(() => true),
        unregister: vi.fn(),
        unregisterAll: vi.fn()
      },
      lifecycleService: {
        getTraySummary: vi.fn(async () => ({
          residentEnabled: true,
          backgroundPaused: false,
          backgroundTasks: {
            total: 1,
            running: 1,
            failed: 0,
            pendingConfirmation: 0,
            nextRunAt: '2026-06-05T01:00:00.000Z'
          },
          nextRunAt: '2026-06-05T01:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z'
        })),
        pauseBackgroundExecution,
        resumeBackgroundExecution: vi.fn()
      },
      logService: createLogServiceMock(),
      menu,
      trayIconPath,
      createTray: vi.fn(() => tray),
      openMainPage: vi.fn(),
      broadcastTaskUpdated
    });

    host.refreshTray();
    await Promise.resolve();

    const template = menu.buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{ label?: string; click?: () => void }>;
    const pauseItem = template.find((item) => item.label === '暂停后台执行');
    if (pauseItem?.click === undefined) {
      throw new Error('pause tray item was not built.');
    }

    pauseItem.click();
    await Promise.resolve();

    expect(pauseBackgroundExecution).toHaveBeenCalledTimes(1);
    expect(broadcastTaskUpdated).toHaveBeenCalledTimes(1);
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Roc 已暂停后台执行');
  });

  it('surfaces global hotkey registration failures instead of silently accepting them', () => {
    const register = vi.fn(() => false);
    const logService = createLogServiceMock();
    const host = new WindowsHostService({
      app: createAppMock(),
      globalShortcut: {
        register,
        unregister: vi.fn(),
        unregisterAll: vi.fn()
      },
      lifecycleService: {
        getTraySummary: vi.fn(() => ({
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
          updatedAt: '2026-05-27T00:00:00.000Z'
        })),
        pauseBackgroundExecution: vi.fn(),
        resumeBackgroundExecution: vi.fn()
      },
      logService,
      menu: {
        buildFromTemplate: vi.fn((template) => template)
      },
      trayIconPath,
      createTray: vi.fn(() => createTrayMock()),
      openMainPage: vi.fn(),
      broadcastTaskUpdated: vi.fn()
    });

    host.syncSettings(createSettings({ globalHotkey: 'Ctrl+Alt+R' }));

    expect(register).toHaveBeenCalledWith('Ctrl+Alt+R', expect.any(Function));
    expect(host.getIntegrationStatus()).toEqual({
      startup: {
        configuredOpenAtLogin: false,
        effectiveOpenAtLogin: false,
        syncError: null
      },
      globalHotkey: {
        accelerator: 'Ctrl+Alt+R',
        registered: false,
        registrationError: 'globalShortcut.register returned false.'
      }
    });
    expect(logService.warn).toHaveBeenCalledWith('Roc global hotkey registration failed.', {
      service: 'windows-host',
      component: 'syncSettings',
      metadata: {
        accelerator: 'Ctrl+Alt+R'
      }
    });
  });
});
