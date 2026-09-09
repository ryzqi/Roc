import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../src/shared/types';
import { MacOSHostService } from '../../src/main/macos-host-service';

type WindowEvent = 'close';
type AppEvent = 'before-quit' | 'second-instance';
type TrayEvent = 'click';
const trayIconPath = '/Applications/Roc.app/Contents/Resources/trayTemplate.png';

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    schemaVersion: 2,
    defaultWorkspace: null,
    startup: {
      openAtLogin: false,
      ...overrides.startup
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
      autoMemory: {
        enabled: true,
        lowConfidenceTtlDays: 30,
        auditRetentionDays: 30,
        maxCandidatesPerRun: 8
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

describe('MacOSHostService', () => {
  it.each([false, true])('reports login-item availability for packaged=%s', (isPackaged) => {
    const app = createAppMock();
    const getLoginItemSettings = vi.fn(() => ({ openAtLogin: true, status: 'requires-approval' as const }));
    const host = new MacOSHostService({
      isPackaged,
      app: { ...app, getLoginItemSettings },
      globalShortcut: { register: vi.fn(), unregister: vi.fn(), unregisterAll: vi.fn() },
      lifecycleService: { getTraySummary: vi.fn(), pauseBackgroundExecution: vi.fn(), resumeBackgroundExecution: vi.fn() },
      logService: createLogServiceMock(),
      menu: { buildFromTemplate: vi.fn() },
      trayIconPath,
      createTray: vi.fn(() => createTrayMock()),
      openMainPage: vi.fn(),
      broadcastTaskUpdated: vi.fn()
    });
    vi.spyOn(host, 'refreshTray').mockImplementation(() => undefined);
    host.syncSettings(createSettings({ startup: { openAtLogin: true } }));
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(host.getIntegrationStatus().startup).toEqual({
      configuredOpenAtLogin: true,
      effectiveOpenAtLogin: false,
      syncError: isPackaged ? '请在系统设置的登录项中允许 Roc。' : '请在打包后的 Roc.app 中设置登录启动。'
    });
  });

  it('keeps single-instance ownership and focuses the existing window on second-instance', async () => {
    const app = createAppMock({ singleInstanceLock: true });
    const mainWindow = createWindowMock({ minimized: true });
    const logService = createLogServiceMock();
    const tray = createTrayMock();
    const host = new MacOSHostService({
      isPackaged: true,
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

    const secondInstanceHandler = app.handlers.get('second-instance');
    if (secondInstanceHandler === undefined) {
      throw new Error('second-instance handler was not registered.');
    }

    await secondInstanceHandler({}, ['/Applications/Roc.app/Contents/MacOS/Roc', 'roc://open/tasks']);

    expect(mainWindow.restore).toHaveBeenCalledTimes(1);
    expect(mainWindow.show).toHaveBeenCalledTimes(1);
    expect(mainWindow.focus).toHaveBeenCalledTimes(1);
    expect(logService.info).toHaveBeenCalledWith('Roc received second-instance launch arguments.', {
      service: 'macos-host',
      component: 'initializeProcessIdentity',
      metadata: {
        argv: ['roc://open/tasks']
      }
    });
  });

  it('hides the main window on close and exits only after an explicit quit', () => {
    const app = createAppMock();
    const mainWindow = createWindowMock();
    const host = new MacOSHostService({
      isPackaged: true,
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

    host.syncSettings(createSettings());
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

  it('keeps macOS background tasks alive before settings are synchronized', () => {
    const mainWindow = createWindowMock();
    const host = new MacOSHostService({
      isPackaged: true,
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
    const preventQuit = vi.fn();
    closeHandler({ preventDefault: preventQuit });
    expect(preventQuit).not.toHaveBeenCalled();
  });

  it('syncs open-at-login and global hotkey state, and wires tray actions to lifecycle callbacks', async () => {
    const app = createAppMock({ loginItemOpenAtLogin: true });
    app.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: false });
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
    const host = new MacOSHostService({
      isPackaged: true,
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

    host.syncSettings(createSettings({ startup: { openAtLogin: true }, globalHotkey: 'Command+Shift+R' }));

    expect(app.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        openAtLogin: true
      })
    );
    expect(host.getIntegrationStatus()).toEqual({
      startup: {
        configuredOpenAtLogin: true,
        effectiveOpenAtLogin: true,
        syncError: null
      },
      globalHotkey: {
        accelerator: 'Command+Shift+R',
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

    const openItem = template.find((item) => item.label === '打开 Roc');
    if (openItem?.click === undefined) throw new Error('open menu item was not built.');
    openItem.click();
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
    const host = new MacOSHostService({
      isPackaged: true,
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
    const host = new MacOSHostService({
      isPackaged: true,
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

    host.syncSettings(createSettings({ globalHotkey: 'Command+Shift+R' }));

    expect(register).toHaveBeenCalledWith('Command+Shift+R', expect.any(Function));
    expect(host.getIntegrationStatus()).toEqual({
      startup: {
        configuredOpenAtLogin: false,
        effectiveOpenAtLogin: false,
        syncError: null
      },
      globalHotkey: {
        accelerator: 'Command+Shift+R',
        registered: false,
        registrationError: 'globalShortcut.register returned false.'
      }
    });
    expect(logService.warn).toHaveBeenCalledWith('Roc global hotkey registration failed.', {
      service: 'macos-host',
      component: 'syncSettings',
      metadata: {
        accelerator: 'Command+Shift+R'
      }
    });
  });
});
