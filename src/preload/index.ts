import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels, type RocPreloadApi } from '../shared/ipc';

const rocApi: RocPreloadApi = {
  app: {
    getStatus: () => ipcRenderer.invoke(ipcChannels.appGetStatus),
    openSettings: () => ipcRenderer.invoke(ipcChannels.appOpenSettings),
    openMainPage: (page) => ipcRenderer.invoke(ipcChannels.appOpenMainPage, page),
    openQuickEntry: () => ipcRenderer.invoke(ipcChannels.appOpenQuickEntry),
    openTrayEntry: () => ipcRenderer.invoke(ipcChannels.appOpenTrayEntry),
    onAppearanceUpdated: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, appearance: Parameters<typeof callback>[0]) => callback(appearance);
      ipcRenderer.on('roc:appearance:updated', listener);
      return () => ipcRenderer.off('roc:appearance:updated', listener);
    },
    onNavigate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, page: string) => callback(page);
      ipcRenderer.on('roc:navigate', listener);
      return () => ipcRenderer.off('roc:navigate', listener);
    }
  },
  window: {
    getState: () => ipcRenderer.invoke(ipcChannels.windowGetState),
    getBounds: () => ipcRenderer.invoke(ipcChannels.windowGetBounds),
    minimize: () => ipcRenderer.invoke(ipcChannels.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(ipcChannels.windowToggleMaximize),
    close: () => ipcRenderer.invoke(ipcChannels.windowClose)
  },
  tasks: {
    getSnapshot: () => ipcRenderer.invoke(ipcChannels.tasksGetSnapshot),
    getThreadMessages: (request) => ipcRenderer.invoke(ipcChannels.tasksGetThreadMessages, request),
    listBackgroundTasks: () => ipcRenderer.invoke(ipcChannels.tasksListBackgroundTasks),
    deleteThread: (request) => ipcRenderer.invoke(ipcChannels.tasksDeleteThread, request),
    createBackgroundTaskPreview: (request) => ipcRenderer.invoke(ipcChannels.tasksCreateBackgroundPreview, request),
    createBackgroundTask: (preview) => ipcRenderer.invoke(ipcChannels.tasksCreateBackgroundTask, preview),
    pauseBackgroundTask: (id) => ipcRenderer.invoke(ipcChannels.tasksPauseBackgroundTask, id),
    resumeBackgroundTask: (id) => ipcRenderer.invoke(ipcChannels.tasksResumeBackgroundTask, id),
    cancelBackgroundTask: (id) => ipcRenderer.invoke(ipcChannels.tasksCancelBackgroundTask, id),
    getActiveTasks: () => ipcRenderer.invoke(ipcChannels.tasksGetActiveTasks),
    getTaskDetail: (request) => ipcRenderer.invoke(ipcChannels.tasksGetTaskDetail, request),
    listScheduledRuns: (request) => ipcRenderer.invoke(ipcChannels.tasksListScheduledRuns, request),
    runBackgroundNow: (id) => ipcRenderer.invoke(ipcChannels.tasksRunBackgroundNow, id),
    deleteBackgroundTask: (id) => ipcRenderer.invoke(ipcChannels.tasksDeleteBackgroundTask, id),
    updateBackgroundTask: (request) => ipcRenderer.invoke(ipcChannels.tasksUpdateBackgroundTask, request),
    openInChat: (request) => ipcRenderer.invoke(ipcChannels.tasksOpenInChat, request),
    getSchedulerStatus: () => ipcRenderer.invoke(ipcChannels.tasksGetSchedulerStatus),
    onUpdated: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on('roc:tasks:updated', listener);
      return () => ipcRenderer.off('roc:tasks:updated', listener);
    }
  },
  lifecycle: {
    getTraySummary: () => ipcRenderer.invoke(ipcChannels.lifecycleGetTraySummary),
    pauseBackgroundExecution: () => ipcRenderer.invoke(ipcChannels.lifecyclePauseBackground),
    resumeBackgroundExecution: () => ipcRenderer.invoke(ipcChannels.lifecycleResumeBackground)
  },
  diagnostics: {
    samplePerformance: (request) => ipcRenderer.invoke(ipcChannels.diagnosticsSamplePerformance, request),
    createDiagnosticPackage: (request) => ipcRenderer.invoke(ipcChannels.diagnosticsCreatePackage, request),
    runChecks: () => ipcRenderer.invoke(ipcChannels.diagnosticsRunChecks)
  },
  memory: {
    status: () => ipcRenderer.invoke(ipcChannels.memoryStatus),
    readFile: (input) => ipcRenderer.invoke(ipcChannels.memoryReadFile, input),
    writeFile: (request) => ipcRenderer.invoke(ipcChannels.memoryWriteFile, request),
    snapshotPreview: () => ipcRenderer.invoke(ipcChannels.memorySnapshotPreview)
  },
  mcp: {
    listServers: () => ipcRenderer.invoke(ipcChannels.mcpListServers),
    ensureExaPreset: () => ipcRenderer.invoke(ipcChannels.mcpEnsureExaPreset),
    upsertServer: (server) => ipcRenderer.invoke(ipcChannels.mcpUpsertServer, server),
    setServerEnabled: (request) => ipcRenderer.invoke(ipcChannels.mcpSetServerEnabled, request),
    deleteServer: (id) => ipcRenderer.invoke(ipcChannels.mcpDeleteServer, id),
    testServer: (id) => ipcRenderer.invoke(ipcChannels.mcpTestServer, id)
  },
  skills: {
    list: () => ipcRenderer.invoke(ipcChannels.skillsList),
    importSkill: (request) => ipcRenderer.invoke(ipcChannels.skillsImport, request),
    setEnabled: (request) => ipcRenderer.invoke(ipcChannels.skillsSetEnabled, request),
    deleteSkill: (id) => ipcRenderer.invoke(ipcChannels.skillsDelete, id),
    listFiles: (request) => ipcRenderer.invoke(ipcChannels.skillsListFiles, request),
    readFile: (request) => ipcRenderer.invoke(ipcChannels.skillsReadFile, request)
  },
  settings: {
    get: () => ipcRenderer.invoke(ipcChannels.settingsGet),
    save: (settings) => ipcRenderer.invoke(ipcChannels.settingsSave, settings),
    testProvider: (id) => ipcRenderer.invoke(ipcChannels.settingsTestProvider, id),
    setProviderSecret: (request) => ipcRenderer.invoke(ipcChannels.settingsSetProviderSecret, request),
    clearProviderSecret: (providerId) => ipcRenderer.invoke(ipcChannels.settingsClearProviderSecret, providerId)
  },
  agent: {
    getStatus: () => ipcRenderer.invoke(ipcChannels.agentGetStatus),
    getConfigPreview: () => ipcRenderer.invoke(ipcChannels.agentGetConfigPreview),
    getCapabilityPreview: (request) => ipcRenderer.invoke(ipcChannels.agentGetCapabilityPreview, request)
  },
  chat: {
    startRun: (request) => ipcRenderer.invoke(ipcChannels.chatStartRun, request),
    cancelRun: (runId) => ipcRenderer.invoke(ipcChannels.chatCancelRun, runId),
    resumeRun: (request) => ipcRenderer.invoke(ipcChannels.chatResumeRun, request),
    onRunEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on(ipcChannels.chatRunEvent, listener);
      return () => ipcRenderer.off(ipcChannels.chatRunEvent, listener);
    }
  },
  workspace: {
    getCurrent: () => ipcRenderer.invoke(ipcChannels.workspaceGetCurrent),
    select: (request) => ipcRenderer.invoke(ipcChannels.workspaceSelect, request),
    selectFromDialog: () => ipcRenderer.invoke(ipcChannels.workspaceSelectFromDialog)
  },
  files: {
    selectFromDialog: () => ipcRenderer.invoke(ipcChannels.filesSelectFromDialog),
    listTree: (request) => ipcRenderer.invoke(ipcChannels.filesListTree, request),
    search: (request) => ipcRenderer.invoke(ipcChannels.filesSearch, request),
    preview: (request) => ipcRenderer.invoke(ipcChannels.filesPreview, request),
    previewPdf: (request) => ipcRenderer.invoke(ipcChannels.filesPreviewPdf, request),
    writeText: (request) => ipcRenderer.invoke(ipcChannels.filesWriteText, request)
  },
  git: {
    status: () => ipcRenderer.invoke(ipcChannels.gitStatus),
    diffStat: () => ipcRenderer.invoke(ipcChannels.gitDiffStat),
    fileDiff: (request) => ipcRenderer.invoke(ipcChannels.gitFileDiff, request),
    stageFile: (request) => ipcRenderer.invoke(ipcChannels.gitStageFile, request),
    stageFiles: (request) => ipcRenderer.invoke(ipcChannels.gitStageFiles, request),
    unstageFile: (request) => ipcRenderer.invoke(ipcChannels.gitUnstageFile, request),
    discardFile: (request) => ipcRenderer.invoke(ipcChannels.gitDiscardFile, request),
    commit: (request) => ipcRenderer.invoke(ipcChannels.gitCommit, request),
    push: () => ipcRenderer.invoke(ipcChannels.gitPush),
    listBranches: () => ipcRenderer.invoke(ipcChannels.gitListBranches),
    createBranch: (request) => ipcRenderer.invoke(ipcChannels.gitCreateBranch, request),
    checkoutBranch: (request) => ipcRenderer.invoke(ipcChannels.gitCheckoutBranch, request)
  },
  terminal: {
    createSession: (request) => ipcRenderer.invoke(ipcChannels.terminalCreateSession, request),
    writeInput: (request) => ipcRenderer.invoke(ipcChannels.terminalWriteInput, request),
    resize: (request) => ipcRenderer.invoke(ipcChannels.terminalResize, request),
    closeSession: (request) => ipcRenderer.invoke(ipcChannels.terminalCloseSession, request),
    onOutput: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on('roc:terminal:output', listener);
      return () => ipcRenderer.off('roc:terminal:output', listener);
    },
    onExit: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on('roc:terminal:exit', listener);
      return () => ipcRenderer.off('roc:terminal:exit', listener);
    }
  },
  rtk: {
    status: () => ipcRenderer.invoke(ipcChannels.rtkStatus)
  },
  shell: {
    execute: (request) => ipcRenderer.invoke(ipcChannels.shellExecute, request),
    confirm: (request) => ipcRenderer.invoke(ipcChannels.shellConfirm, request)
  }
};

contextBridge.exposeInMainWorld('roc', rocApi);
