import { type BrowserWindow, ipcMain } from 'electron';

import { ipcChannels } from '../../shared/ipc';
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
import { toLogError, wrapIpc } from '../services/errors';
import { registerFilesDialogIpc } from './files-ipc';
import { executeIpcRequest, type IpcHandler, type IpcMainHandler } from './ipc-common';
import { registerPluginCapabilityIpc } from './plugin-capability-adapter';
import { registerSettingsIpc } from './settings-ipc';
import { registerShellConfirmIpc } from './shell-ipc';
import { registerWindowIpc } from './window-ipc';
import { registerWorkspaceDialogIpc } from './workspace-ipc';

export type AppWindowControls = {
  openMainPage: (page: string) => void;
  closeMainWindow: () => void;
  syncHostSettings: (settings: AppSettings) => void;
  getHostIntegrationStatus: () => HostIntegrationStatus;
  broadcastTaskUpdated: (event?: TaskUpdateEvent) => void;
};

const slowIpcThresholdMs = 50;

export function registerIpc(
  kernel: MainKernelBootstrap,
  mainWindow: BrowserWindow,
  controls: AppWindowControls
): void {
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
    ipcMain.handle(channel, (event: unknown, ...args: unknown[]) =>
      timedIpc(channel, args.length, () => executeIpcRequest(channel, event, args, handler))
    );
  }

  registerPluginCapabilityIpc(timedHandle, kernel);
  registerLegacyAppSupplementIpc(timedHandle, controls);
  registerWindowIpc(timedHandle, mainWindow, controls);
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

function registerLegacyAppSupplementIpc(timedHandle: (channel: string, handler: IpcMainHandler) => void, controls: AppWindowControls): void {
  timedHandle(ipcChannels.appOpenSettings, () =>
    wrapIpc(() => {
      controls.openMainPage('settings');
      return { opened: true as const };
    })
  );
  timedHandle(ipcChannels.appOpenMainPage, (_event, page: string) =>
    wrapIpc(() => {
      controls.openMainPage(page);
      return { opened: true as const, page };
    })
  );
}
