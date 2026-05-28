import { type BrowserWindow, ipcMain } from 'electron';
import type { AppSettings, HostIntegrationStatus, IpcResult, TaskUpdateEvent } from '../../shared/types';
import type { AppServices } from '../services/app-service';
import { registerAgentIpc } from './agent-ipc';
import { registerAppIpc } from './app-ipc';
import { registerChatIpc } from './chat-ipc';
import { registerDiagnosticsIpc } from './diagnostics-ipc';
import { registerFilesIpc } from './files-ipc';
import { registerGitIpc } from './git-ipc';
import { registerLifecycleIpc } from './lifecycle-ipc';
import { registerMcpIpc } from './mcp-ipc';
import { registerMemoryIpc } from './memory-ipc';
import { registerRtkIpc } from './rtk-ipc';
import { registerSettingsIpc } from './settings-ipc';
import { registerShellIpc } from './shell-ipc';
import { registerSkillsIpc } from './skills-ipc';
import { registerTasksIpc } from './tasks-ipc';
import { registerTerminalIpc } from './terminal-ipc';
import { registerWindowIpc } from './window-ipc';
import { registerWorkspaceIpc } from './workspace-ipc';
import type { IpcHandler, IpcMainHandler } from './ipc-common';

export type AppWindowControls = {
  openMainPage: (page: string) => void;
  openQuickEntry: () => Promise<void>;
  openTrayEntry: () => Promise<void>;
  closeMainWindow: () => void;
  syncHostSettings: (settings: AppSettings) => void;
  getHostIntegrationStatus: () => HostIntegrationStatus;
  broadcastTaskUpdated: (event?: TaskUpdateEvent) => void;
};

const slowIpcThresholdMs = 50;

export function registerIpc(services: AppServices, mainWindow: BrowserWindow, controls: AppWindowControls): void {
  function timedIpc<T>(channel: string, operation: IpcHandler<T>): Promise<IpcResult<T>> {
    const startedAtMs = performance.now();
    return Promise.resolve(operation()).then((result) => {
      const durationMs = performance.now() - startedAtMs;
      services.performanceObserverService.record({
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
        services.logService.append({
          level: 'warn',
          message: 'Slow IPC handler recorded.',
          data: {
            channel,
            durationMs,
            ok: result.ok
          }
        });
      }
      return result;
    }).catch((error: unknown) => {
      const durationMs = performance.now() - startedAtMs;
      services.performanceObserverService.record({
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
        services.logService.append({
          level: 'warn',
          message: 'Slow IPC handler recorded.',
          data: {
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
    ipcMain.handle(channel, (...args: any[]) => timedIpc(channel, () => handler(...args)));
  }

  registerAppIpc(timedHandle, services.appService, controls);
  registerWindowIpc(timedHandle, mainWindow, controls);
  registerTasksIpc(timedHandle, services.taskService, services.taskSchedulerService, controls);
  registerLifecycleIpc(timedHandle, services.lifecycleService, controls);
  registerDiagnosticsIpc(timedHandle, services.diagnosticsService, services.taskSchedulerService);
  registerMemoryIpc(timedHandle, services.memoryService, services.sessionArchiveService);
  registerSettingsIpc(
    timedHandle,
    services.configService,
    services.secretService,
    services.mcpService,
    services.skillService,
    services.providerRuntimeService,
    controls
  );
  registerMcpIpc(timedHandle, services.mcpService);
  registerSkillsIpc(timedHandle, services.skillService);
  registerAgentIpc(timedHandle, services.agentService);
  registerChatIpc(timedHandle, services.deepAgentRuntimeService);
  registerWorkspaceIpc(timedHandle, mainWindow, services.workspaceService);
  registerFilesIpc(timedHandle, mainWindow, services.workspaceService, services.fileService);
  registerGitIpc(timedHandle, services.gitService);
  registerTerminalIpc(timedHandle, services.terminalSessionService);
  registerRtkIpc(timedHandle, services.rtkService);
  registerShellIpc(timedHandle, mainWindow, services.logService, services.shellExecutionService);
}
