import { type BrowserWindow, ipcMain } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import type { AppSettings, HostIntegrationStatus, IpcResult, TaskUpdateEvent } from '../../shared/types';
import type { AppServices } from '../services/app-service';
import { wrapIpc } from '../services/errors';
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
import { registerPluginCapabilityIpc, type PluginCapabilityInvoker } from './plugin-capability-adapter';

export type AppWindowControls = {
  openMainPage: (page: string) => void;
  closeMainWindow: () => void;
  syncHostSettings: (settings: AppSettings) => void;
  getHostIntegrationStatus: () => HostIntegrationStatus;
  broadcastTaskUpdated: (event?: TaskUpdateEvent) => void;
};

const slowIpcThresholdMs = 50;

export function registerIpc(
  services: AppServices,
  mainWindow: BrowserWindow,
  controls: AppWindowControls,
  pluginCapabilityInvoker?: PluginCapabilityInvoker
): void {
  function timedIpc<T>(channel: string, argsLength: number, operation: IpcHandler<T>): Promise<IpcResult<T>> {
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
        services.logService.warn('Slow IPC handler recorded.', {
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
      services.logService.error('IPC handler failed.', toLogError(error), {
        service: 'ipc',
        component: 'register-ipc',
        metadata: {
          channel,
          args: argsLength
        }
      });
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
        services.logService.warn('Slow IPC handler recorded.', {
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
    ipcMain.handle(channel, (...args: any[]) => timedIpc(channel, args.length, () => handler(...args)));
  }

  if (pluginCapabilityInvoker !== undefined) {
    registerPluginCapabilityIpc(timedHandle, pluginCapabilityInvoker);
    registerAppIpc(timedHandle, services.appService, controls);
    registerWindowIpc(timedHandle, mainWindow, controls);
    registerLegacyTaskSupplementIpc(timedHandle, services, controls);
    registerSettingsIpc(
      timedHandle,
      services.configService,
      services.secretService,
      services.mcpService,
      services.skillService,
      services.providerRuntimeService,
      controls
    );
    registerLegacyMcpSupplementIpc(timedHandle, services);
    registerLegacyAgentSupplementIpc(timedHandle, services);
    registerWorkspaceIpc(timedHandle, mainWindow, services.workspaceService);
    registerFilesIpc(timedHandle, mainWindow, services.workspaceService, services.fileService);
    registerGitIpc(timedHandle, services.gitService);
    registerTerminalIpc(timedHandle, services.terminalSessionService);
    registerRtkIpc(timedHandle, services.rtkService);
    registerShellIpc(timedHandle, mainWindow, services.logService, services.shellExecutionService);
    return;
  }

  registerAppIpc(timedHandle, services.appService, controls);
  registerWindowIpc(timedHandle, mainWindow, controls);
  registerTasksIpc(timedHandle, services.taskService, services.taskSchedulerService, controls);
  registerLifecycleIpc(timedHandle, services.lifecycleService, controls);
  registerDiagnosticsIpc(
    timedHandle,
    services.diagnosticsService,
    services.taskSchedulerService,
    services.healthCheckService,
    services.metricsService
  );
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

function toLogError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function registerLegacyAgentSupplementIpc(timedHandle: (channel: string, handler: IpcMainHandler) => void, services: AppServices): void {
  timedHandle(ipcChannels.agentGetConfigPreview, () =>
    wrapIpc(() => services.agentService.getDeepAgentConfigPreview())
  );
  timedHandle(ipcChannels.agentGetCapabilityPreview, (_event, request) =>
    wrapIpc(() => services.agentService.getCapabilityPreview(request))
  );
}

function registerLegacyMcpSupplementIpc(timedHandle: (channel: string, handler: IpcMainHandler) => void, services: AppServices): void {
  timedHandle(ipcChannels.mcpEnsureExaPreset, () => wrapIpc(() => services.mcpService.ensureExaPreset()));
}

function registerLegacyTaskSupplementIpc(
  timedHandle: (channel: string, handler: IpcMainHandler) => void,
  services: AppServices,
  controls: Pick<AppWindowControls, 'broadcastTaskUpdated'>
): void {
  timedHandle(ipcChannels.tasksGetThreadMessages, (_event, request) =>
    wrapIpc(() => services.taskService.listThreadMessages(request.threadId))
  );
  timedHandle(ipcChannels.tasksListBackgroundTasks, () => wrapIpc(() => services.taskService.listBackgroundTasks()));
  timedHandle(ipcChannels.tasksDeleteThread, (_event, request) =>
    wrapIpc(() => {
      const linkedTaskIds = services.taskService
        .listBackgroundTasks()
        .filter((task) => task.threadId === request.threadId)
        .map((task) => task.id);
      const result = services.taskService.archiveThread(request.threadId);
      for (const taskId of linkedTaskIds) {
        services.taskSchedulerService.unregisterTask(taskId);
      }
      controls.broadcastTaskUpdated();
      return result;
    })
  );
  timedHandle(ipcChannels.tasksGetActiveTasks, () => wrapIpc(() => services.taskService.getActiveTasks()));
  timedHandle(ipcChannels.tasksGetTaskDetail, (_event, request) =>
    wrapIpc(() =>
      services.taskService.getTaskDetail({
        taskId: request.taskId,
        schedulerRegistered: services.taskSchedulerService.getStatus().registeredTaskCount > 0
      })
    )
  );
  timedHandle(ipcChannels.tasksListScheduledRuns, (_event, request) =>
    wrapIpc(() => services.taskService.listScheduledRuns(request))
  );
  timedHandle(ipcChannels.tasksUpdateBackgroundTask, (_event, request) =>
    wrapIpc(() => {
      const task = services.taskService.updateBackgroundTask(request);
      services.taskSchedulerService.refreshTask(task);
      controls.broadcastTaskUpdated({ kind: 'task_status_changed', taskId: task.id, status: task.status });
      return task;
    })
  );
  timedHandle(ipcChannels.tasksOpenInChat, (_event, request) =>
    wrapIpc(() => services.taskService.openBackgroundTaskInChat(request.taskId))
  );
}
