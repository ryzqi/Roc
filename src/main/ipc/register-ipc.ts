import { BrowserWindow, dialog, ipcMain } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import type { SettingsSnapshot } from '../../shared/types';
import { RocDomainError, wrapIpc } from '../services/errors';
import type { AppServices } from '../services/app-service';
import { getWindowBounds, getWindowState } from '../window-shell';

export type AppWindowControls = {
  openMainPage: (page: string) => void;
  openQuickEntry: () => Promise<void>;
  openTrayEntry: () => Promise<void>;
};

function buildSettingsSnapshot(services: AppServices): SettingsSnapshot {
  const providers = services.configService.getProviders();
  return {
    settings: services.configService.getSettings(),
    providers: providers.providers,
    defaultModelId: providers.defaultModelId,
    mcpServers: services.mcpService.listServers(),
    skills: services.skillService.list()
  };
}

export function registerIpc(services: AppServices, mainWindow: BrowserWindow, controls: AppWindowControls): void {
  ipcMain.handle(ipcChannels.appGetStatus, () => wrapIpc(() => services.appService.getStatus()));
  ipcMain.handle(ipcChannels.appOpenSettings, () =>
    wrapIpc(() => {
      controls.openMainPage('settings');
      return { opened: true as const };
    })
  );
  ipcMain.handle(ipcChannels.appOpenMainPage, (_event, page: string) =>
    wrapIpc(() => {
      controls.openMainPage(page);
      return { opened: true as const, page };
    })
  );
  ipcMain.handle(ipcChannels.appOpenQuickEntry, () =>
    wrapIpc(async () => {
      await controls.openQuickEntry();
      return { opened: true as const };
    })
  );
  ipcMain.handle(ipcChannels.appOpenTrayEntry, () =>
    wrapIpc(async () => {
      await controls.openTrayEntry();
      return { opened: true as const };
    })
  );
  ipcMain.handle(ipcChannels.windowGetState, () => wrapIpc(() => getWindowState(mainWindow)));
  ipcMain.handle(ipcChannels.windowGetBounds, () => wrapIpc(() => getWindowBounds(mainWindow)));
  ipcMain.handle(ipcChannels.windowSetBounds, (_event, bounds) =>
    wrapIpc(() => {
      mainWindow.setBounds(bounds);
      return getWindowBounds(mainWindow);
    })
  );
  ipcMain.handle(ipcChannels.windowMinimize, () =>
    wrapIpc(() => {
      mainWindow.minimize();
      return getWindowState(mainWindow);
    })
  );
  ipcMain.handle(ipcChannels.windowToggleMaximize, () =>
    wrapIpc(() => {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      return getWindowState(mainWindow);
    })
  );
  ipcMain.handle(ipcChannels.windowClose, () =>
    wrapIpc(() => {
      mainWindow.close();
      return { closed: true as const };
    })
  );
  ipcMain.handle(ipcChannels.tasksGetSnapshot, () => wrapIpc(() => services.taskService.getSnapshot()));
  ipcMain.handle(ipcChannels.tasksListBackgroundTasks, () => wrapIpc(() => services.taskService.listBackgroundTasks()));
  ipcMain.handle(ipcChannels.tasksCreateBackgroundPreview, (_event, request) =>
    wrapIpc(() => services.taskService.createBackgroundTaskPreview(request))
  );
  ipcMain.handle(ipcChannels.tasksCreateBackgroundTask, (_event, preview) =>
    wrapIpc(() => services.taskService.createBackgroundTask(preview))
  );
  ipcMain.handle(ipcChannels.tasksPauseBackgroundTask, (_event, id: string) =>
    wrapIpc(() => services.taskService.pauseBackgroundTask(id))
  );
  ipcMain.handle(ipcChannels.tasksResumeBackgroundTask, (_event, id: string) =>
    wrapIpc(() => services.taskService.resumeBackgroundTask(id))
  );
  ipcMain.handle(ipcChannels.tasksCancelBackgroundTask, (_event, id: string) =>
    wrapIpc(() => services.taskService.cancelBackgroundTask(id))
  );
  ipcMain.handle(ipcChannels.lifecycleGetTraySummary, () => wrapIpc(() => services.lifecycleService.getTraySummary()));
  ipcMain.handle(ipcChannels.lifecyclePauseBackground, () =>
    wrapIpc(() => services.lifecycleService.pauseBackgroundExecution())
  );
  ipcMain.handle(ipcChannels.lifecycleResumeBackground, () =>
    wrapIpc(() => services.lifecycleService.resumeBackgroundExecution())
  );
  ipcMain.handle(ipcChannels.diagnosticsSamplePerformance, (_event, request) =>
    wrapIpc(() => services.diagnosticsService.samplePerformance(request))
  );
  ipcMain.handle(ipcChannels.diagnosticsCreatePackage, (_event, request) =>
    wrapIpc(() => services.diagnosticsService.createDiagnosticPackage(request))
  );
  ipcMain.handle(ipcChannels.memoryStatus, () => wrapIpc(() => services.memoryService.status()));
  ipcMain.handle(ipcChannels.memorySearch, (_event, request) => wrapIpc(() => services.memoryService.search(request)));
  ipcMain.handle(ipcChannels.memoryGet, (_event, id: string) => wrapIpc(() => services.memoryService.get(id)));
  ipcMain.handle(ipcChannels.memoryListCandidates, () => wrapIpc(() => services.memoryService.listCandidates()));
  ipcMain.handle(ipcChannels.memoryListConflicts, () => wrapIpc(() => services.memoryService.listConflicts()));
  ipcMain.handle(ipcChannels.memoryAcceptCandidate, (_event, id: string) =>
    wrapIpc(() => services.memoryService.acceptCandidate(id))
  );
  ipcMain.handle(ipcChannels.memoryRejectCandidate, (_event, id: string) =>
    wrapIpc(() => services.memoryService.rejectCandidate(id))
  );
  ipcMain.handle(ipcChannels.memoryWriteCandidate, (_event, entry) =>
    wrapIpc(() => services.memoryService.writeCandidate(entry))
  );
  ipcMain.handle(ipcChannels.memoryWriteSessionRecall, (_event, request) =>
    wrapIpc(() => services.memoryService.writeSessionRecall(request))
  );
  ipcMain.handle(ipcChannels.memorySessionSearch, (_event, request) =>
    wrapIpc(() => services.memoryService.sessionSearch(request))
  );
  ipcMain.handle(ipcChannels.memoryDelete, (_event, id: string) => wrapIpc(() => services.memoryService.deleteMemory(id)));
  ipcMain.handle(ipcChannels.memoryRestore, (_event, id: string) =>
    wrapIpc(() => services.memoryService.restoreMemory(id))
  );
  ipcMain.handle(ipcChannels.settingsGet, () => wrapIpc(() => buildSettingsSnapshot(services)));
  ipcMain.handle(ipcChannels.settingsSave, (_event, settings) =>
    wrapIpc(() => {
      services.configService.saveSettingsSnapshot(settings);
      return buildSettingsSnapshot(services);
    })
  );
  ipcMain.handle(ipcChannels.settingsTestProvider, (_event, id: string) =>
    wrapIpc(() => services.configService.testProvider(id))
  );
  ipcMain.handle(ipcChannels.mcpListServers, () => wrapIpc(() => services.mcpService.listServers()));
  ipcMain.handle(ipcChannels.mcpEnsureExaPreset, () => wrapIpc(() => services.mcpService.ensureExaPreset()));
  ipcMain.handle(ipcChannels.mcpUpsertServer, (_event, server) => wrapIpc(() => services.mcpService.upsertServer(server)));
  ipcMain.handle(ipcChannels.mcpSetServerEnabled, (_event, request) =>
    wrapIpc(() => services.mcpService.setServerEnabled(request.id, request.enabled))
  );
  ipcMain.handle(ipcChannels.mcpDeleteServer, (_event, id: string) =>
    wrapIpc(() => {
      services.mcpService.deleteServer(id);
      return { deleted: true as const };
    })
  );
  ipcMain.handle(ipcChannels.mcpTestServer, (_event, id: string) => wrapIpc(() => services.mcpService.testServer(id)));
  ipcMain.handle(ipcChannels.skillsList, () => wrapIpc(() => services.skillService.list()));
  ipcMain.handle(ipcChannels.skillsImport, (_event, request) => wrapIpc(() => services.skillService.importSkill(request)));
  ipcMain.handle(ipcChannels.skillsSetEnabled, (_event, request) =>
    wrapIpc(() => services.skillService.setEnabled(request.id, request.enabled))
  );
  ipcMain.handle(ipcChannels.skillsDelete, (_event, id: string) =>
    wrapIpc(() => {
      services.skillService.deleteSkill(id);
      return { deleted: true as const };
    })
  );
  ipcMain.handle(ipcChannels.doctorGetLatest, () => wrapIpc(() => services.doctorService.getLatest()));
  ipcMain.handle(ipcChannels.doctorRun, () => wrapIpc(() => services.doctorService.run()));
  ipcMain.handle(ipcChannels.agentGetStatus, () => wrapIpc(() => services.agentService.getStatus()));
  ipcMain.handle(ipcChannels.agentGetConfigPreview, () => wrapIpc(() => services.agentService.getDeepAgentConfigPreview()));
  ipcMain.handle(ipcChannels.agentGetCapabilityPreview, (_event, request) =>
    wrapIpc(() => services.agentService.getCapabilityPreview(request))
  );
  ipcMain.handle(ipcChannels.chatSubmit, (_event, request) => wrapIpc(() => services.chatService.submit(request)));
  ipcMain.handle(ipcChannels.workspaceGetCurrent, () => wrapIpc(() => services.workspaceService.getCurrentWorkspace()));
  ipcMain.handle(ipcChannels.workspaceSelect, (_event, request) =>
    wrapIpc(() => services.workspaceService.selectWorkspace(request.path))
  );
  ipcMain.handle(ipcChannels.workspaceSelectFromDialog, () =>
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
  ipcMain.handle(ipcChannels.filesSelectFromDialog, () =>
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
  ipcMain.handle(ipcChannels.filesListTree, (_event, request) => wrapIpc(() => services.fileService.listTree(request)));
  ipcMain.handle(ipcChannels.filesSearch, (_event, request) => wrapIpc(() => services.fileService.search(request)));
  ipcMain.handle(ipcChannels.filesPreview, (_event, request) => wrapIpc(() => services.fileService.readPreview(request)));
  ipcMain.handle(ipcChannels.filesWriteText, (_event, request) => wrapIpc(() => services.fileService.writeTextFile(request)));
  ipcMain.handle(ipcChannels.gitStatus, () => wrapIpc(() => services.gitService.getStatus()));
  ipcMain.handle(ipcChannels.gitDiffStat, () => wrapIpc(() => services.gitService.getDiffStat()));
  ipcMain.handle(ipcChannels.gitFileDiff, (_event, request) =>
    wrapIpc(() => services.gitService.getFileDiff(request.relativePath))
  );
  ipcMain.handle(ipcChannels.gitStageFile, (_event, request) =>
    wrapIpc(() => services.gitService.stageFile(request.relativePath))
  );
  ipcMain.handle(ipcChannels.gitStageFiles, (_event, request) =>
    wrapIpc(() => services.gitService.stageFiles(request.relativePaths))
  );
  ipcMain.handle(ipcChannels.gitUnstageFile, (_event, request) =>
    wrapIpc(() => services.gitService.unstageFile(request.relativePath))
  );
  ipcMain.handle(ipcChannels.gitDiscardFile, (_event, request) =>
    wrapIpc(() => services.gitService.discardFileChanges(request.relativePath))
  );
  ipcMain.handle(ipcChannels.gitCommit, (_event, request) => wrapIpc(() => services.gitService.commit(request.message)));
  ipcMain.handle(ipcChannels.gitPush, () => wrapIpc(() => services.gitService.push()));
  ipcMain.handle(ipcChannels.gitListBranches, () => wrapIpc(() => services.gitService.listBranches()));
  ipcMain.handle(ipcChannels.gitCreateBranch, (_event, request) =>
    wrapIpc(() => services.gitService.createBranch(request.name, request.checkoutAfterCreate))
  );
  ipcMain.handle(ipcChannels.gitCheckoutBranch, (_event, request) =>
    wrapIpc(() => services.gitService.checkoutBranch(request.name))
  );
  ipcMain.handle(ipcChannels.terminalCreateSession, (_event, request) =>
    wrapIpc(() => services.terminalSessionService.createSession(request))
  );
  ipcMain.handle(ipcChannels.terminalWriteInput, (_event, request) =>
    wrapIpc(() => services.terminalSessionService.writeInput(request))
  );
  ipcMain.handle(ipcChannels.terminalResize, (_event, request) =>
    wrapIpc(() => services.terminalSessionService.resize(request))
  );
  ipcMain.handle(ipcChannels.terminalCloseSession, (_event, request) =>
    wrapIpc(() => services.terminalSessionService.closeSession(request))
  );
  ipcMain.handle(ipcChannels.rtkStatus, () => wrapIpc(() => services.rtkService.getStatus()));
  ipcMain.handle(ipcChannels.shellExecute, (_event, request) =>
    wrapIpc(() => services.shellExecutionService.execute(request))
  );
}
