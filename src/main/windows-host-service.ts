import type { AppSettings, HostIntegrationStatus, TraySummary } from '../shared/types';
import type { LogService } from './services/log-service';

type MainWindowLike = {
  on: (event: 'close', handler: (event: { preventDefault: () => void }) => void) => void;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  hide: () => void;
};

type AppLike = {
  requestSingleInstanceLock: () => boolean;
  setAppUserModelId: (id: string) => void;
  on: (event: 'before-quit' | 'second-instance', listener: (...args: unknown[]) => void) => void;
  quit: () => void;
  setLoginItemSettings: (settings: {
    openAtLogin: boolean;
    enabled: boolean;
    path: string;
    args: string[];
    name: string;
  }) => void;
  getLoginItemSettings: (settings: { path: string; args: string[] }) => {
    openAtLogin: boolean;
    executableWillLaunchAtLogin?: boolean;
  };
};

type GlobalShortcutLike = {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
  unregisterAll: () => void;
};

type TrayLike = {
  setToolTip: (tooltip: string) => void;
  setContextMenu: (menu: unknown) => void;
  on: (event: 'click', handler: () => void | Promise<void>) => void;
  destroy: () => void;
};

type MenuLike = {
  buildFromTemplate: (template: TrayMenuItem[]) => unknown;
};

type LifecycleResult = TraySummary | Promise<TraySummary>;

type TrayMenuItem = {
  label?: string;
  type?: 'separator';
  click?: () => void;
};

export const windowsAppUserModelId = 'com.roc.desktop';

function createDefaultHostIntegrationStatus(): HostIntegrationStatus {
  return {
    startup: {
      configuredOpenAtLogin: false,
      effectiveOpenAtLogin: false,
      syncError: null
    },
    globalHotkey: {
      accelerator: null,
      registered: false,
      registrationError: null
    }
  };
}

export class WindowsHostService {
  private readonly hostIntegration = createDefaultHostIntegrationStatus();
  private mainWindow: MainWindowLike | null = null;
  private tray: TrayLike | null = null;
  private explicitQuit = false;
  private currentHotkey: string | null = null;
  private minimizeToTray = true;
  private shutdownApplied = false;

  constructor(
    private readonly input: {
      app: AppLike;
      globalShortcut: GlobalShortcutLike;
      lifecycleService: {
        getTraySummary(): LifecycleResult;
        pauseBackgroundExecution(): LifecycleResult;
        resumeBackgroundExecution(): LifecycleResult;
      };
      logService: Pick<LogService, 'info' | 'warn' | 'error'>;
      menu: MenuLike;
      trayIconPath: string;
      createTray: (iconPath: string) => TrayLike;
      openMainPage: (page: string) => void;
      broadcastTaskUpdated: () => void;
    }
  ) {}

  initializeProcessIdentity(): boolean {
    this.input.app.setAppUserModelId(windowsAppUserModelId);
    const acquiredLock = this.input.app.requestSingleInstanceLock();
    if (!acquiredLock) {
      return false;
    }
    this.input.app.on('before-quit', () => {
      this.explicitQuit = true;
      this.shutdown();
    });
    this.input.app.on('second-instance', (_event, commandLine) => {
      this.focusMainWindow();
      const args = Array.isArray(commandLine) ? commandLine.slice(1) : [];
      if (args.length > 0) {
        this.input.logService.info('Roc received second-instance launch arguments.', {
          service: 'windows-host',
          component: 'initializeProcessIdentity',
          metadata: {
            argv: args
          }
        });
      }
    });
    return true;
  }

  bindMainWindow(window: MainWindowLike): void {
    this.mainWindow = window;
    window.on('close', (event) => {
      if (this.explicitQuit || !this.minimizeToTray) {
        return;
      }
      event.preventDefault();
      window.hide();
    });
  }

  syncSettings(settings: AppSettings): void {
    this.minimizeToTray = settings.startup.minimizeToTray;
    this.hostIntegration.startup.configuredOpenAtLogin = settings.startup.openAtLogin;
    this.hostIntegration.startup.syncError = null;
    try {
      const loginItemSettings = this.buildLoginItemSettings(settings.startup.openAtLogin);
      this.input.app.setLoginItemSettings(loginItemSettings);
      const actualLoginItem = this.input.app.getLoginItemSettings({
        path: loginItemSettings.path,
        args: loginItemSettings.args
      });
      this.hostIntegration.startup.effectiveOpenAtLogin = actualLoginItem.openAtLogin;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hostIntegration.startup.syncError = message;
      this.hostIntegration.startup.effectiveOpenAtLogin = false;
      this.input.logService.error('Roc open-at-login sync failed.', toLogError(error), {
        service: 'windows-host',
        component: 'syncSettings'
      });
    }

    if (this.currentHotkey !== null) {
      this.input.globalShortcut.unregister(this.currentHotkey);
      this.currentHotkey = null;
    }
    this.hostIntegration.globalHotkey = {
      accelerator: settings.globalHotkey,
      registered: false,
      registrationError: null
    };
    if (settings.globalHotkey !== null) {
      try {
        const registered = this.input.globalShortcut.register(settings.globalHotkey, () => {
          this.input.openMainPage('chat');
        });
        this.hostIntegration.globalHotkey.registered = registered;
        if (registered) {
          this.currentHotkey = settings.globalHotkey;
        } else {
          this.hostIntegration.globalHotkey.registrationError = 'globalShortcut.register returned false.';
          this.input.logService.warn('Roc global hotkey registration failed.', {
            service: 'windows-host',
            component: 'syncSettings',
            metadata: {
              accelerator: settings.globalHotkey
            }
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.hostIntegration.globalHotkey.registrationError = message;
        this.input.logService.warn('Roc global hotkey registration failed.', {
          service: 'windows-host',
          component: 'syncSettings',
          metadata: {
            accelerator: settings.globalHotkey,
            error: message
          }
        });
      }
    }

    this.refreshTray();
  }

  refreshTray(): void {
    this.applyTraySummaryResult(this.input.lifecycleService.getTraySummary());
  }

  private applyTraySummaryResult(result: LifecycleResult): void {
    if (result instanceof Promise) {
      void result.then((summary) => {
        this.applyTraySummary(summary);
      });
      return;
    }
    this.applyTraySummary(result);
  }

  private applyTraySummary(summary: TraySummary): void {
    const tray = this.ensureTray();
    tray.setToolTip(summary.backgroundPaused ? 'Roc 已暂停后台执行' : 'Roc 正在后台运行');
    tray.setContextMenu(
      this.input.menu.buildFromTemplate([
        {
          label: '打开 Roc',
          click: () => {
            this.input.openMainPage('chat');
          }
        },
        {
          label: summary.backgroundPaused ? '恢复后台执行' : '暂停后台执行',
          click: () => {
            const nextSummary = summary.backgroundPaused
              ? this.input.lifecycleService.resumeBackgroundExecution()
              : this.input.lifecycleService.pauseBackgroundExecution();
            this.applyTrayMutationResult(nextSummary);
          }
        },
        {
          label: '打开任务',
          click: () => {
            this.input.openMainPage('tasks');
          }
        },
        {
          type: 'separator'
        },
        {
          label: '退出',
          click: () => {
            this.requestQuit();
          }
        }
      ])
    );
  }

  private applyTrayMutationResult(result: LifecycleResult): void {
    const applyMutation = (summary: TraySummary): void => {
      this.input.broadcastTaskUpdated();
      this.applyTraySummary(summary);
    };
    if (result instanceof Promise) {
      void result.then(applyMutation);
      return;
    }
    applyMutation(result);
  }

  getIntegrationStatus(): HostIntegrationStatus {
    return {
      startup: { ...this.hostIntegration.startup },
      globalHotkey: { ...this.hostIntegration.globalHotkey }
    };
  }

  requestQuit(): void {
    this.explicitQuit = true;
    this.input.app.quit();
  }

  shutdown(): void {
    if (this.shutdownApplied) {
      return;
    }
    this.shutdownApplied = true;
    this.input.globalShortcut.unregisterAll();
    this.tray?.destroy();
  }

  private buildLoginItemSettings(openAtLogin: boolean): {
    openAtLogin: boolean;
    enabled: boolean;
    path: string;
    args: string[];
    name: string;
  } {
    return {
      openAtLogin,
      enabled: openAtLogin,
      path: process.execPath,
      args: [],
      name: windowsAppUserModelId
    };
  }

  private ensureTray(): TrayLike {
    if (this.tray !== null) {
      return this.tray;
    }
    this.tray = this.input.createTray(this.input.trayIconPath);
    this.tray.on('click', () => this.input.openMainPage('chat'));
    return this.tray;
  }

  private focusMainWindow(): void {
    if (this.mainWindow === null) {
      return;
    }
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    this.mainWindow.show();
    this.mainWindow.focus();
  }
}

function toLogError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
