import { BrowserWindow, dialog, ipcMain } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import type { IpcResult, ProviderSecretSetRequest, SettingsSnapshot, TaskUpdateEvent } from '../../shared/types';
import { RocDomainError, wrapIpc } from '../services/errors';
import type { AppServices } from '../services/app-service';
import { getWindowBounds, getWindowState } from '../window-shell';

export type AppWindowControls = {
  openMainPage: (page: string) => void;
  openQuickEntry: () => Promise<void>;
  openTrayEntry: () => Promise<void>;
  broadcastTaskUpdated: (event?: TaskUpdateEvent) => void;
};

type IpcHandler<T> = () => Promise<IpcResult<T>> | IpcResult<T>;
type IpcMainHandler = (...args: any[]) => Promise<IpcResult<unknown>> | IpcResult<unknown>;

const slowIpcThresholdMs = 50;

function buildSettingsSnapshot(services: AppServices): SettingsSnapshot {
  const providersConfig = services.configService.getProviders();
  const providerSecretStatus = services.secretService.listSecretStatuses(
    providersConfig.providers.map((provider) => provider.id)
  );
  return {
    settings: services.configService.getSettings(),
    providers: providersConfig.providers,
    defaultModelId: providersConfig.defaultModelId,
    providerSecretStatus,
    permissions: services.configService.getPermissions(),
    mcpServers: services.mcpService.listServers(),
    skills: services.skillService.list()
  };
}

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

  timedHandle(ipcChannels.appGetStatus, () => wrapIpc(() => services.appService.getStatus()));
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
  timedHandle(ipcChannels.appOpenQuickEntry, () =>
    wrapIpc(async () => {
      await controls.openQuickEntry();
      return { opened: true as const };
    })
  );
  timedHandle(ipcChannels.appOpenTrayEntry, () =>
    wrapIpc(async () => {
      await controls.openTrayEntry();
      return { opened: true as const };
    })
  );
  timedHandle(ipcChannels.windowGetState, () => wrapIpc(() => getWindowState(mainWindow)));
  timedHandle(ipcChannels.windowGetBounds, () => wrapIpc(() => getWindowBounds(mainWindow)));
  timedHandle(ipcChannels.windowSetBounds, (_event, bounds) =>
    wrapIpc(() => {
      mainWindow.setBounds(bounds);
      return getWindowBounds(mainWindow);
    })
  );
  timedHandle(ipcChannels.windowMinimize, () =>
    wrapIpc(() => {
      mainWindow.minimize();
      return getWindowState(mainWindow);
    })
  );
  timedHandle(ipcChannels.windowToggleMaximize, () =>
    wrapIpc(() => {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      return getWindowState(mainWindow);
    })
  );
  timedHandle(ipcChannels.windowClose, () =>
    wrapIpc(() => {
      mainWindow.close();
      return { closed: true as const };
    })
  );
  timedHandle(ipcChannels.tasksGetSnapshot, () => wrapIpc(() => services.taskService.getSnapshot()));
  timedHandle(ipcChannels.tasksGetThreadMessages, (_event, request) =>
    wrapIpc(() => services.taskService.listThreadMessages(request.threadId))
  );
  timedHandle(ipcChannels.tasksListBackgroundTasks, () => wrapIpc(() => services.taskService.listBackgroundTasks()));
  timedHandle(ipcChannels.tasksDeleteThread, (_event, request) =>
    wrapIpc(() => {
      const result = services.taskService.archiveThread(request.threadId);
      controls.broadcastTaskUpdated();
      return result;
    })
  );
  timedHandle(ipcChannels.tasksCreateBackgroundPreview, (_event, request) =>
    wrapIpc(() => services.taskService.createBackgroundTaskPreview(request))
  );
  timedHandle(ipcChannels.tasksCreateBackgroundTask, (_event, preview) =>
    wrapIpc(() => {
      const task = services.taskService.createBackgroundTask(preview);
      services.taskSchedulerService.registerTask(task);
      controls.broadcastTaskUpdated();
      return task;
    })
  );
  timedHandle(ipcChannels.tasksPauseBackgroundTask, (_event, id: string) =>
    wrapIpc(() => {
      const task = services.taskService.pauseBackgroundTask(id);
      services.taskSchedulerService.unregisterTask(task.id);
      controls.broadcastTaskUpdated();
      return task;
    })
  );
  timedHandle(ipcChannels.tasksResumeBackgroundTask, (_event, id: string) =>
    wrapIpc(() => {
      const task = services.taskService.resumeBackgroundTask(id);
      services.taskSchedulerService.registerTask(task);
      controls.broadcastTaskUpdated();
      return task;
    })
  );
  timedHandle(ipcChannels.tasksCancelBackgroundTask, (_event, id: string) =>
    wrapIpc(() => {
      const task = services.taskService.cancelBackgroundTask(id);
      controls.broadcastTaskUpdated({ kind: 'task_status_changed', taskId: task.id, status: task.status });
      return task;
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
  timedHandle(ipcChannels.tasksRunBackgroundNow, async (_event, id: string) =>
    wrapIpc(async () => {
      const runId = await services.taskSchedulerService.fire(id);
      const resolvedRunId = runId ?? id;
      controls.broadcastTaskUpdated({ kind: 'task_run_fired', taskId: id, runId: resolvedRunId });
      return { taskId: id, runId: resolvedRunId };
    })
  );
  timedHandle(ipcChannels.tasksDeleteBackgroundTask, (_event, id: string) =>
    wrapIpc(() => {
      const result = services.taskService.deleteBackgroundTask(id);
      controls.broadcastTaskUpdated();
      return result;
    })
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
  timedHandle(ipcChannels.tasksPromoteThread, (_event, request) =>
    wrapIpc(() => {
      const thread = services.taskService.promoteThread(request);
      controls.broadcastTaskUpdated({ kind: 'thread_promoted', threadId: thread.id, reason: request.reason });
      return thread;
    })
  );
  timedHandle(ipcChannels.tasksGetSchedulerStatus, () => wrapIpc(() => services.taskSchedulerService.getStatus()));
  timedHandle(ipcChannels.lifecycleGetTraySummary, () => wrapIpc(() => services.lifecycleService.getTraySummary()));
  timedHandle(ipcChannels.lifecyclePauseBackground, () =>
    wrapIpc(() => services.lifecycleService.pauseBackgroundExecution())
  );
  timedHandle(ipcChannels.lifecycleResumeBackground, () =>
    wrapIpc(() => services.lifecycleService.resumeBackgroundExecution())
  );
  timedHandle(ipcChannels.diagnosticsSamplePerformance, (_event, request) =>
    wrapIpc(() => services.diagnosticsService.samplePerformance(request))
  );
  timedHandle(ipcChannels.diagnosticsCreatePackage, (_event, request) =>
    wrapIpc(() => services.diagnosticsService.createDiagnosticPackage(request))
  );
  timedHandle(ipcChannels.diagnosticsRunChecks, () =>
    wrapIpc(() => services.diagnosticsService.runChecks(services.taskSchedulerService.getStatus()))
  );
  timedHandle(ipcChannels.memoryStatus, () => wrapIpc(() => services.memoryService.status()));
  timedHandle(ipcChannels.memorySearch, (_event, request) => wrapIpc(() => services.memoryService.search(request)));
  timedHandle(ipcChannels.memoryGet, (_event, id: string) => wrapIpc(() => services.memoryService.get(id)));
  timedHandle(ipcChannels.memoryListCandidates, () => wrapIpc(() => services.memoryService.listCandidates()));
  timedHandle(ipcChannels.memoryListConflicts, () => wrapIpc(() => services.memoryService.listConflicts()));
  timedHandle(ipcChannels.memoryAcceptCandidate, (_event, id: string) =>
    wrapIpc(() => services.memoryService.acceptCandidate(id))
  );
  timedHandle(ipcChannels.memoryRejectCandidate, (_event, id: string) =>
    wrapIpc(() => services.memoryService.rejectCandidate(id))
  );
  timedHandle(ipcChannels.memoryWriteCandidate, (_event, entry) =>
    wrapIpc(() => services.memoryService.writeCandidate(entry))
  );
  timedHandle(ipcChannels.memoryWriteSessionRecall, (_event, request) =>
    wrapIpc(() => services.memoryService.writeSessionRecall(request))
  );
  timedHandle(ipcChannels.memorySessionSearch, (_event, request) =>
    wrapIpc(() => services.memoryService.sessionSearch(request))
  );
  timedHandle(ipcChannels.memoryDelete, (_event, id: string) => wrapIpc(() => services.memoryService.deleteMemory(id)));
  timedHandle(ipcChannels.memoryRestore, (_event, id: string) =>
    wrapIpc(() => services.memoryService.restoreMemory(id))
  );
  timedHandle(ipcChannels.settingsGet, () => wrapIpc(() => buildSettingsSnapshot(services)));
  timedHandle(ipcChannels.settingsSave, (_event, settings) =>
    wrapIpc(() => {
      services.configService.saveSettingsSnapshot(settings);
      return buildSettingsSnapshot(services);
    })
  );
  timedHandle(ipcChannels.settingsTestProvider, (_event, id: string) =>
    wrapIpc(() => services.providerRuntimeService.testProvider(id))
  );
  timedHandle(ipcChannels.settingsSetProviderSecret, (_event, request: ProviderSecretSetRequest) =>
    wrapIpc(() => {
      services.secretService.setProviderSecret(request.providerId, request.plaintext);
      return { providerId: request.providerId, stored: true as const };
    })
  );
  timedHandle(ipcChannels.settingsClearProviderSecret, (_event, providerId: string) =>
    wrapIpc(() => {
      services.secretService.clearProviderSecret(providerId);
      const provider = services.configService.getProviders().providers.find((entry) => entry.id === providerId);
      if (provider?.type === 'llama_cpp' && provider.credentialRef !== null) {
        services.configService.upsertProvider({
          ...provider,
          credentialRef: null
        });
      }
      return { providerId, stored: false as const };
    })
  );
  timedHandle(ipcChannels.mcpListServers, () => wrapIpc(() => services.mcpService.listServers()));
  timedHandle(ipcChannels.mcpEnsureExaPreset, () => wrapIpc(() => services.mcpService.ensureExaPreset()));
  timedHandle(ipcChannels.mcpUpsertServer, (_event, server) => wrapIpc(() => services.mcpService.upsertServer(server)));
  timedHandle(ipcChannels.mcpSetServerEnabled, (_event, request) =>
    wrapIpc(() => services.mcpService.setServerEnabled(request.id, request.enabled))
  );
  timedHandle(ipcChannels.mcpDeleteServer, (_event, id: string) =>
    wrapIpc(() => {
      services.mcpService.deleteServer(id);
      return { deleted: true as const };
    })
  );
  timedHandle(ipcChannels.mcpTestServer, (_event, id: string) => wrapIpc(() => services.mcpService.testServer(id)));
  timedHandle(ipcChannels.skillsList, () => wrapIpc(() => services.skillService.list()));
  timedHandle(ipcChannels.skillsImport, (_event, request) => wrapIpc(() => services.skillService.importSkill(request)));
  timedHandle(ipcChannels.skillsSetEnabled, (_event, request) =>
    wrapIpc(() => services.skillService.setEnabled(request.id, request.enabled))
  );
  timedHandle(ipcChannels.skillsDelete, (_event, id: string) =>
    wrapIpc(() => {
      services.skillService.deleteSkill(id);
      return { deleted: true as const };
    })
  );
  timedHandle(ipcChannels.skillsListFiles, (_event, request) =>
    wrapIpc(() => services.skillService.listFiles(request))
  );
  timedHandle(ipcChannels.skillsReadFile, (_event, request) =>
    wrapIpc(() => services.skillService.readFile(request))
  );
  timedHandle(ipcChannels.agentGetStatus, () => wrapIpc(() => services.agentService.getStatus()));
  timedHandle(ipcChannels.agentGetConfigPreview, () => wrapIpc(() => services.agentService.getDeepAgentConfigPreview()));
  timedHandle(ipcChannels.agentGetCapabilityPreview, (_event, request) =>
    wrapIpc(() => services.agentService.getCapabilityPreview(request))
  );
  timedHandle(ipcChannels.chatStartRun, (_event, request) =>
    wrapIpc(() => services.deepAgentRuntimeService.startRun(request))
  );
  timedHandle(ipcChannels.chatCancelRun, (_event, runId: string) =>
    wrapIpc(() => services.deepAgentRuntimeService.cancelRun(runId))
  );
  timedHandle(ipcChannels.chatResumeRun, (_event, request) =>
    wrapIpc(() => services.deepAgentRuntimeService.resumeRun(request))
  );
  timedHandle(ipcChannels.workspaceGetCurrent, () => wrapIpc(() => services.workspaceService.getCurrentWorkspace()));
  timedHandle(ipcChannels.workspaceSelect, (_event, request) =>
    wrapIpc(() => services.workspaceService.selectWorkspace(request.path))
  );
  timedHandle(ipcChannels.workspaceSelectFromDialog, () =>
    wrapIpc(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择工作区',
        properties: ['openDirectory']
      });
      if (result.canceled) {
        return null;
      }
      const selectedPath = result.filePaths[0];
      if (selectedPath === undefined) {
        throw new RocDomainError({
          code: 'workspace_dialog_empty_selection',
          message: '没有收到工作区目录。',
          category: 'validation',
          retryable: true,
          userAction: '请重新选择一个目录作为工作区。'
        });
      }
      return services.workspaceService.selectWorkspace(selectedPath);
    })
  );
  timedHandle(ipcChannels.filesSelectFromDialog, () =>
    wrapIpc(async () => {
      if (process.env.ROC_SMOKE === '1') {
        const smokeWorkspace = services.workspaceService.getCurrentWorkspace();
        if (smokeWorkspace !== null) {
          return {
            filePaths: [`${smokeWorkspace.path}\\phase-three-notes.txt`]
          };
        }
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择文件',
        properties: ['openFile', 'multiSelections']
      });
      if (result.canceled) {
        return null;
      }
      return {
        filePaths: result.filePaths
      };
    })
  );
  timedHandle(ipcChannels.filesListTree, (_event, request) => wrapIpc(() => services.fileService.listTree(request)));
  timedHandle(ipcChannels.filesSearch, (_event, request) => wrapIpc(() => services.fileService.search(request)));
  timedHandle(ipcChannels.filesPreview, (_event, request) => wrapIpc(() => services.fileService.readPreview(request)));
  timedHandle(ipcChannels.filesPreviewPdf, (_event, request) =>
    wrapIpc(() => services.fileService.readPdfWorkbenchPreview(request))
  );
  timedHandle(ipcChannels.filesWriteText, (_event, request) => wrapIpc(() => services.fileService.writeTextFile(request)));
  timedHandle(ipcChannels.gitStatus, () => wrapIpc(() => services.gitService.getStatusAsync()));
  timedHandle(ipcChannels.gitDiffStat, () => wrapIpc(() => services.gitService.getDiffStatAsync()));
  timedHandle(ipcChannels.gitFileDiff, (_event, request) =>
    wrapIpc(() => services.gitService.getFileDiffAsync(request.relativePath))
  );
  timedHandle(ipcChannels.gitStageFile, (_event, request) =>
    wrapIpc(() => services.gitService.stageFile(request.relativePath))
  );
  timedHandle(ipcChannels.gitStageFiles, (_event, request) =>
    wrapIpc(() => services.gitService.stageFiles(request.relativePaths))
  );
  timedHandle(ipcChannels.gitUnstageFile, (_event, request) =>
    wrapIpc(() => services.gitService.unstageFile(request.relativePath))
  );
  timedHandle(ipcChannels.gitDiscardFile, (_event, request) =>
    wrapIpc(() => services.gitService.discardFileChanges(request.relativePath))
  );
  timedHandle(ipcChannels.gitCommit, (_event, request) => wrapIpc(() => services.gitService.commit(request.message)));
  timedHandle(ipcChannels.gitPush, () => wrapIpc(() => services.gitService.push()));
  timedHandle(ipcChannels.gitListBranches, () => wrapIpc(() => services.gitService.listBranchesAsync()));
  timedHandle(ipcChannels.gitCreateBranch, (_event, request) =>
    wrapIpc(() => services.gitService.createBranch(request.name, request.checkoutAfterCreate))
  );
  timedHandle(ipcChannels.gitCheckoutBranch, (_event, request) =>
    wrapIpc(() => services.gitService.checkoutBranch(request.name))
  );
  timedHandle(ipcChannels.terminalCreateSession, (_event, request) =>
    wrapIpc(() => services.terminalSessionService.createSession(request))
  );
  timedHandle(ipcChannels.terminalWriteInput, (_event, request) =>
    wrapIpc(() => services.terminalSessionService.writeInput(request))
  );
  timedHandle(ipcChannels.terminalResize, (_event, request) =>
    wrapIpc(() => services.terminalSessionService.resize(request))
  );
  timedHandle(ipcChannels.terminalCloseSession, (_event, request) =>
    wrapIpc(() => services.terminalSessionService.closeSession(request))
  );
  timedHandle(ipcChannels.rtkStatus, () => wrapIpc(() => services.rtkService.getStatus()));
  timedHandle(ipcChannels.shellExecute, (_event, request) =>
    wrapIpc(() => services.shellExecutionService.executeAsync(request))
  );
}
