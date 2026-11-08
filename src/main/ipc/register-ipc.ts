import {registerRadarBrowserIpc} from './radar-browser-ipc';
import { type BrowserWindow, ipcMain } from 'electron';

import { ipcChannels } from '../../shared/ipc';
import type { MenuPage } from '../../shared/surfaces';
import type {
  AppSettings,
  HostIntegrationStatus,
  IpcResult,
  McpServerSnapshot,
  SkillSnapshot,
  TaskUpdateEvent,
  Workspace
} from '../../shared/types';
import type { MainKernelBootstrap } from '../main-kernel-bootstrap';
import { RocDomainError, toLogError, wrapIpc } from '../services/errors';
import { createIpcSenderValidator } from './ipc-sender';
import { registerFilesDialogIpc } from './files-ipc';
import { executeIpcRequest, type IpcHandler, type IpcMainHandler } from './ipc-common';
import { registerPluginCapabilityIpc } from './plugin-capability-adapter';
import { registerSettingsIpc } from './settings-ipc';
import { registerShellConfirmIpc } from './shell-ipc';
import { registerWindowIpc } from './window-ipc';
import { registerWorkspaceDialogIpc } from './workspace-ipc';

export type AppWindowControls = {
  openMainPage: (page: MenuPage) => void;
  closeMainWindow: () => void;
  syncHostSettings: (settings: AppSettings) => void;
  getHostIntegrationStatus: () => HostIntegrationStatus;
  broadcastTaskUpdated: (event?: TaskUpdateEvent) => void;
};

const slowIpcThresholdMs = 50;

export function registerIpc(
  kernel: MainKernelBootstrap,
  mainWindow: BrowserWindow,
  controls: AppWindowControls,
  rendererUrl: string
): void {
  const isTrustedSender = createIpcSenderValidator(mainWindow, rendererUrl);
  function timedIpc<T>(channel: string, argsLength: number, operation: IpcHandler<T>): Promise<IpcResult<T>> {
    const startedAtMs = performance.now();
    return Promise.resolve(operation()).then((result) => {
      const durationMs = performance.now() - startedAtMs;
      kernel.performanceObserverService.record({
        phase: 'ipc_call',
        label: channel,
        startedAtMs,
        durationMs,
        metadata: {
          channel,
          ok: result.ok
        }
      });
      if (durationMs > slowIpcThresholdMs) {
        kernel.logService.warn('Slow IPC handler recorded.', {
          service: 'ipc',
          component: 'register-ipc',
          metadata: {
            channel,
            durationMs,
            ok: result.ok
          }
        });
      }
      return result;
    }).catch((error: unknown) => {
      const durationMs = performance.now() - startedAtMs;
      kernel.logService.error('IPC handler failed.', toLogError(error), {
        service: 'ipc',
        component: 'register-ipc',
        metadata: {
          channel,
          args: argsLength
        }
      });
      kernel.performanceObserverService.record({
        phase: 'ipc_call',
        label: channel,
        startedAtMs,
        durationMs,
        metadata: {
          channel,
          ok: false
        }
      });
      if (durationMs > slowIpcThresholdMs) {
        kernel.logService.warn('Slow IPC handler recorded.', {
          service: 'ipc',
          component: 'register-ipc',
          metadata: {
            channel,
            durationMs,
            ok: false
          }
        });
      }
      throw error;
    });
  }

  function timedHandle(channel: string, handler: IpcMainHandler): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      // Check synchronously, before parsing input or running any handler.
      if (!isTrustedSender(event)) {
        return wrapIpc(() => {
          throw new RocDomainError({
            code: 'ipc_sender_forbidden', message: '此页面无权调用应用接口。',
            category: 'permission', retryable: false
          });
        });
      }
      return timedIpc(channel, args.length, () => executeIpcRequest(channel, event, args, handler));
    });
  }

  registerPluginCapabilityIpc(timedHandle, kernel);
  registerAppNavigationIpc(timedHandle, controls);
  registerWindowIpc(timedHandle, mainWindow, controls);
  registerRadarBrowserIpc(timedHandle, mainWindow);
  registerShellConfirmIpc(timedHandle, mainWindow, kernel.logService);
  registerSettingsIpc(
    timedHandle,
    kernel.configService,
    kernel.secretService,
    kernel.providerRuntimeService,
    {
      listMcpServers: () => kernel.invokeCapability<{}, McpServerSnapshot[]>('mcp.listServers', {}),
      listSkills: () => kernel.invokeCapability<{}, SkillSnapshot[]>('skills.list', {}),
      syncSettingsSnapshot: (request) => {
        kernel.syncSettingsSnapshot(request);
      }
    },
    controls,
    {
      hookConfigService: kernel.hookConfigService,
      hookTrustService: kernel.hookTrustService
    }
  );
  registerWorkspaceDialogIpc(timedHandle, mainWindow, {
    selectWorkspace: (path) => kernel.invokeCapability('workspace.select', { path })
  });
  registerFilesDialogIpc(timedHandle, mainWindow, {
    getCurrentWorkspace: () => kernel.invokeCapability<{}, Workspace | null>('workspace.getCurrent', {})
  });
}

function registerAppNavigationIpc(timedHandle: (channel: string, handler: IpcMainHandler) => void, controls: AppWindowControls): void {
  timedHandle(ipcChannels.appOpenSettings, () =>
    wrapIpc(() => {
      controls.openMainPage('settings');
      return { opened: true as const };
    })
  );
  timedHandle(ipcChannels.appOpenMainPage, (_event, page: MenuPage) =>
    wrapIpc(() => {
      controls.openMainPage(page);
      return { opened: true as const, page };
    })
  );
}
