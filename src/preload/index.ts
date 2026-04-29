import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels, type RocPreloadApi } from '../shared/ipc';

const rocApi: RocPreloadApi = {
  app: {
    getStatus: () => ipcRenderer.invoke(ipcChannels.appGetStatus),
    openSettings: () => ipcRenderer.invoke(ipcChannels.appOpenSettings),
    openMainPage: (page) => ipcRenderer.invoke(ipcChannels.appOpenMainPage, page),
    openQuickEntry: () => ipcRenderer.invoke(ipcChannels.appOpenQuickEntry),
    openTrayEntry: () => ipcRenderer.invoke(ipcChannels.appOpenTrayEntry),
    onNavigate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, page: string) => callback(page);
      ipcRenderer.on('roc:navigate', listener);
      return () => ipcRenderer.off('roc:navigate', listener);
    }
  },
  window: {
    getState: () => ipcRenderer.invoke(ipcChannels.windowGetState),
    minimize: () => ipcRenderer.invoke(ipcChannels.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(ipcChannels.windowToggleMaximize),
    close: () => ipcRenderer.invoke(ipcChannels.windowClose)
  },
  tasks: {
    getSnapshot: () => ipcRenderer.invoke(ipcChannels.tasksGetSnapshot),
    createBackgroundTaskPreview: (request) => ipcRenderer.invoke(ipcChannels.tasksCreateBackgroundPreview, request),
    createBackgroundTask: (preview) => ipcRenderer.invoke(ipcChannels.tasksCreateBackgroundTask, preview),
    pauseBackgroundTask: (id) => ipcRenderer.invoke(ipcChannels.tasksPauseBackgroundTask, id),
    resumeBackgroundTask: (id) => ipcRenderer.invoke(ipcChannels.tasksResumeBackgroundTask, id),
    cancelBackgroundTask: (id) => ipcRenderer.invoke(ipcChannels.tasksCancelBackgroundTask, id)
  },
  lifecycle: {
    getTraySummary: () => ipcRenderer.invoke(ipcChannels.lifecycleGetTraySummary),
    pauseBackgroundExecution: () => ipcRenderer.invoke(ipcChannels.lifecyclePauseBackground),
    resumeBackgroundExecution: () => ipcRenderer.invoke(ipcChannels.lifecycleResumeBackground)
  },
  diagnostics: {
    samplePerformance: (request) => ipcRenderer.invoke(ipcChannels.diagnosticsSamplePerformance, request),
    createDiagnosticPackage: (request) => ipcRenderer.invoke(ipcChannels.diagnosticsCreatePackage, request)
  },
  memory: {
    status: () => ipcRenderer.invoke(ipcChannels.memoryStatus),
    search: (request) => ipcRenderer.invoke(ipcChannels.memorySearch, request),
    get: (id) => ipcRenderer.invoke(ipcChannels.memoryGet, id),
    listCandidates: () => ipcRenderer.invoke(ipcChannels.memoryListCandidates),
    listConflicts: () => ipcRenderer.invoke(ipcChannels.memoryListConflicts),
    acceptCandidate: (id) => ipcRenderer.invoke(ipcChannels.memoryAcceptCandidate, id),
    rejectCandidate: (id) => ipcRenderer.invoke(ipcChannels.memoryRejectCandidate, id),
    writeCandidate: (entry) => ipcRenderer.invoke(ipcChannels.memoryWriteCandidate, entry),
    writeSessionRecall: (request) => ipcRenderer.invoke(ipcChannels.memoryWriteSessionRecall, request),
    sessionSearch: (request) => ipcRenderer.invoke(ipcChannels.memorySessionSearch, request),
    delete: (id) => ipcRenderer.invoke(ipcChannels.memoryDelete, id),
    restore: (id) => ipcRenderer.invoke(ipcChannels.memoryRestore, id)
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
    deleteSkill: (id) => ipcRenderer.invoke(ipcChannels.skillsDelete, id)
  },
  providers: {
    list: () => ipcRenderer.invoke(ipcChannels.providersList),
    upsert: (provider) => ipcRenderer.invoke(ipcChannels.providersUpsert, provider),
    delete: (id) => ipcRenderer.invoke(ipcChannels.providersDelete, id),
    setDefaultModel: (modelId) => ipcRenderer.invoke(ipcChannels.providersSetDefaultModel, modelId),
    test: (id) => ipcRenderer.invoke(ipcChannels.providersTest, id)
  },
  doctor: {
    getLatest: () => ipcRenderer.invoke(ipcChannels.doctorGetLatest),
    run: () => ipcRenderer.invoke(ipcChannels.doctorRun)
  },
  agent: {
    getStatus: () => ipcRenderer.invoke(ipcChannels.agentGetStatus),
    getConfigPreview: () => ipcRenderer.invoke(ipcChannels.agentGetConfigPreview),
    getCapabilityPreview: (request) => ipcRenderer.invoke(ipcChannels.agentGetCapabilityPreview, request)
  },
  chat: {
    submit: (request) => ipcRenderer.invoke(ipcChannels.chatSubmit, request)
  },
  workspace: {
    getCurrent: () => ipcRenderer.invoke(ipcChannels.workspaceGetCurrent),
    select: (request) => ipcRenderer.invoke(ipcChannels.workspaceSelect, request)
  },
  files: {
    listTree: (request) => ipcRenderer.invoke(ipcChannels.filesListTree, request),
    search: (request) => ipcRenderer.invoke(ipcChannels.filesSearch, request),
    preview: (request) => ipcRenderer.invoke(ipcChannels.filesPreview, request),
    writeText: (request) => ipcRenderer.invoke(ipcChannels.filesWriteText, request)
  },
  git: {
    status: () => ipcRenderer.invoke(ipcChannels.gitStatus),
    diffStat: () => ipcRenderer.invoke(ipcChannels.gitDiffStat)
  },
  rtk: {
    status: () => ipcRenderer.invoke(ipcChannels.rtkStatus)
  },
  shell: {
    execute: (request) => ipcRenderer.invoke(ipcChannels.shellExecute, request)
  }
};

contextBridge.exposeInMainWorld('roc', rocApi);
