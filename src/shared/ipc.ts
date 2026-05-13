import type {
  AgentRuntimeStatus,
  AgentCapabilityPreview,
  AppSettings,
  AppStatus,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatCancelRunResult,
  ChatRunEvent,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatStartRunRequest,
  ChatStartRunResult,
  DeepAgentConfigPreview,
  DiagnosticPackage,
  DiagnosticPackageRequest,
  DoctorSnapshot,
  FilePreviewRequest,
  FilePreviewResult,
  FileSearchRequest,
  FileSearchResult,
  FileTreeRequest,
  FileTreeResult,
  FileWriteResult,
  FileWriteTextRequest,
  GitBatchFileOperationRequest,
  GitBranchListResult,
  GitBranchMutationResult,
  GitCheckoutBranchRequest,
  GitCommitRequest,
  GitCommitResult,
  GitCreateBranchRequest,
  GitDiffStatResult,
  GitFileDiffResult,
  GitFileOperationRequest,
  GitPushResult,
  GitStatusResult,
  IpcResult,
  McpServerConfig,
  McpServerSnapshot,
  McpServerTestResult,
  MemoryCandidate,
  MemoryConflict,
  MemoryDeleteResult,
  MemoryEntry,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStatus,
  PerformanceSample,
  PerformanceSampleRequest,
  ProviderSecretClearResult,
  ProviderSecretSetRequest,
  ProviderSecretSetResult,
  ProviderTestResult,
  RtkStatus,
  SessionRecallEntry,
  SessionRecallWriteRequest,
  SessionSearchRequest,
  SessionSearchResult,
  ShellExecutionRequest,
  ShellExecutionResult,
  SettingsSaveRequest,
  SettingsSnapshot,
  SkillFileEntry,
  SkillFilePreviewRequest,
  SkillFilePreviewResult,
  SkillFileTreeRequest,
  SkillFileTreeResult,
  SkillImportRequest,
  SkillSnapshot,
  TerminalSessionCloseRequest,
  TerminalSessionCreateRequest,
  TerminalSessionExitEvent,
  TerminalSessionInputRequest,
  TerminalSessionOutputEvent,
  TerminalSessionResizeRequest,
  TerminalSessionSnapshot,
  TaskEvent,
  TaskSnapshot,
  TaskMessageHistoryRequest,
  TaskDeleteThreadRequest,
  TaskDeleteThreadResult,
  TraySummary,
  Workspace,
  FileDialogSelection,
  WorkspaceSelectRequest,
  WindowBoundsSnapshot,
  WindowStateSnapshot
} from './types';

export const ipcChannels = {
  appGetStatus: 'roc:app:get-status',
  appOpenSettings: 'roc:app:open-settings',
  appOpenMainPage: 'roc:app:open-main-page',
  appOpenQuickEntry: 'roc:app:open-quick-entry',
  appOpenTrayEntry: 'roc:app:open-tray-entry',
  windowGetState: 'roc:window:get-state',
  windowGetBounds: 'roc:window:get-bounds',
  windowSetBounds: 'roc:window:set-bounds',
  windowMinimize: 'roc:window:minimize',
  windowToggleMaximize: 'roc:window:toggle-maximize',
  windowClose: 'roc:window:close',
  tasksGetSnapshot: 'roc:tasks:get-snapshot',
  tasksGetThreadMessages: 'roc:tasks:get-thread-messages',
  tasksListBackgroundTasks: 'roc:tasks:list-background-tasks',
  tasksDeleteThread: 'roc:tasks:delete-thread',
  tasksCreateBackgroundPreview: 'roc:tasks:create-background-preview',
  tasksCreateBackgroundTask: 'roc:tasks:create-background-task',
  tasksPauseBackgroundTask: 'roc:tasks:pause-background-task',
  tasksResumeBackgroundTask: 'roc:tasks:resume-background-task',
  tasksCancelBackgroundTask: 'roc:tasks:cancel-background-task',
  lifecycleGetTraySummary: 'roc:lifecycle:get-tray-summary',
  lifecyclePauseBackground: 'roc:lifecycle:pause-background',
  lifecycleResumeBackground: 'roc:lifecycle:resume-background',
  diagnosticsSamplePerformance: 'roc:diagnostics:sample-performance',
  diagnosticsCreatePackage: 'roc:diagnostics:create-package',
  memoryStatus: 'roc:memory:status',
  memorySearch: 'roc:memory:search',
  memoryGet: 'roc:memory:get',
  memoryListCandidates: 'roc:memory:list-candidates',
  memoryListConflicts: 'roc:memory:list-conflicts',
  memoryAcceptCandidate: 'roc:memory:accept-candidate',
  memoryRejectCandidate: 'roc:memory:reject-candidate',
  memoryWriteCandidate: 'roc:memory:write-candidate',
  memoryWriteSessionRecall: 'roc:memory:write-session-recall',
  memorySessionSearch: 'roc:memory:session-search',
  memoryDelete: 'roc:memory:delete',
  memoryRestore: 'roc:memory:restore',
  settingsGet: 'roc:settings:get',
  settingsSave: 'roc:settings:save',
  settingsTestProvider: 'roc:settings:test-provider',
  settingsSetProviderSecret: 'roc:settings:set-provider-secret',
  settingsClearProviderSecret: 'roc:settings:clear-provider-secret',
  mcpListServers: 'roc:mcp:list-servers',
  mcpEnsureExaPreset: 'roc:mcp:ensure-exa-preset',
  mcpUpsertServer: 'roc:mcp:upsert-server',
  mcpSetServerEnabled: 'roc:mcp:set-server-enabled',
  mcpSetServerApprovalMode: 'roc:mcp:set-server-approval-mode',
  mcpDeleteServer: 'roc:mcp:delete-server',
  mcpTestServer: 'roc:mcp:test-server',
  skillsList: 'roc:skills:list',
  skillsImport: 'roc:skills:import',
  skillsSetEnabled: 'roc:skills:set-enabled',
  skillsDelete: 'roc:skills:delete',
  skillsListFiles: 'roc:skills:list-files',
  skillsReadFile: 'roc:skills:read-file',
  doctorGetLatest: 'roc:doctor:get-latest',
  doctorRun: 'roc:doctor:run',
  agentGetStatus: 'roc:agent:get-status',
  agentGetConfigPreview: 'roc:agent:get-config-preview',
  agentGetCapabilityPreview: 'roc:agent:get-capability-preview',
  chatRunEvent: 'roc:chat:run-event',
  chatStartRun: 'roc:chat:start-run',
  chatCancelRun: 'roc:chat:cancel-run',
  chatResumeRun: 'roc:chat:resume-run',
  workspaceGetCurrent: 'roc:workspace:get-current',
  workspaceSelect: 'roc:workspace:select',
  workspaceSelectFromDialog: 'roc:workspace:select-from-dialog',
  filesSelectFromDialog: 'roc:files:select-from-dialog',
  filesListTree: 'roc:files:list-tree',
  filesSearch: 'roc:files:search',
  filesPreview: 'roc:files:preview',
  filesWriteText: 'roc:files:write-text',
  gitStatus: 'roc:git:status',
  gitDiffStat: 'roc:git:diff-stat',
  gitFileDiff: 'roc:git:file-diff',
  gitStageFile: 'roc:git:stage-file',
  gitStageFiles: 'roc:git:stage-files',
  gitUnstageFile: 'roc:git:unstage-file',
  gitDiscardFile: 'roc:git:discard-file',
  gitCommit: 'roc:git:commit',
  gitPush: 'roc:git:push',
  gitListBranches: 'roc:git:list-branches',
  gitCreateBranch: 'roc:git:create-branch',
  gitCheckoutBranch: 'roc:git:checkout-branch',
  terminalCreateSession: 'roc:terminal:create-session',
  terminalWriteInput: 'roc:terminal:write-input',
  terminalResize: 'roc:terminal:resize',
  terminalCloseSession: 'roc:terminal:close-session',
  rtkStatus: 'roc:rtk:status',
  shellExecute: 'roc:shell:execute'
} as const;

export type RocPreloadApi = {
  app: {
    getStatus: () => Promise<IpcResult<AppStatus>>;
    openSettings: () => Promise<IpcResult<{ opened: true }>>;
    openMainPage: (page: string) => Promise<IpcResult<{ opened: true; page: string }>>;
    openQuickEntry: () => Promise<IpcResult<{ opened: true }>>;
    openTrayEntry: () => Promise<IpcResult<{ opened: true }>>;
    onNavigate: (callback: (page: string) => void) => () => void;
  };
  window: {
    getState: () => Promise<IpcResult<WindowStateSnapshot>>;
    getBounds: () => Promise<IpcResult<WindowBoundsSnapshot>>;
    setBounds: (bounds: WindowBoundsSnapshot) => Promise<IpcResult<WindowBoundsSnapshot>>;
    minimize: () => Promise<IpcResult<WindowStateSnapshot>>;
    toggleMaximize: () => Promise<IpcResult<WindowStateSnapshot>>;
    close: () => Promise<IpcResult<{ closed: true }>>;
  };
  tasks: {
    getSnapshot: () => Promise<IpcResult<TaskSnapshot>>;
    getThreadMessages: (request: TaskMessageHistoryRequest) => Promise<IpcResult<TaskEvent[]>>;
    listBackgroundTasks: () => Promise<IpcResult<BackgroundTask[]>>;
    deleteThread: (request: TaskDeleteThreadRequest) => Promise<IpcResult<TaskDeleteThreadResult>>;
    createBackgroundTaskPreview: (request: BackgroundTaskPreviewRequest) => Promise<IpcResult<BackgroundTaskPreview>>;
    createBackgroundTask: (preview: BackgroundTaskPreview) => Promise<IpcResult<BackgroundTask>>;
    pauseBackgroundTask: (id: string) => Promise<IpcResult<BackgroundTask>>;
    resumeBackgroundTask: (id: string) => Promise<IpcResult<BackgroundTask>>;
    cancelBackgroundTask: (id: string) => Promise<IpcResult<BackgroundTask>>;
    onUpdated: (callback: () => void) => () => void;
  };
  lifecycle: {
    getTraySummary: () => Promise<IpcResult<TraySummary>>;
    pauseBackgroundExecution: () => Promise<IpcResult<TraySummary>>;
    resumeBackgroundExecution: () => Promise<IpcResult<TraySummary>>;
  };
  diagnostics: {
    samplePerformance: (request: PerformanceSampleRequest) => Promise<IpcResult<PerformanceSample>>;
    createDiagnosticPackage: (request: DiagnosticPackageRequest) => Promise<IpcResult<DiagnosticPackage>>;
  };
  memory: {
    status: () => Promise<IpcResult<MemoryStatus>>;
    search: (request: MemorySearchRequest) => Promise<IpcResult<MemorySearchResult>>;
    get: (id: string) => Promise<IpcResult<string>>;
    listCandidates: () => Promise<IpcResult<MemoryCandidate[]>>;
    listConflicts: () => Promise<IpcResult<MemoryConflict[]>>;
    acceptCandidate: (id: string) => Promise<IpcResult<MemoryEntry>>;
    rejectCandidate: (id: string) => Promise<IpcResult<MemoryCandidate>>;
    writeCandidate: (
      entry: Omit<MemoryEntry, 'id' | 'layer' | 'status' | 'createdAt' | 'updatedAt'>
    ) => Promise<IpcResult<MemoryEntry>>;
    writeSessionRecall: (request: SessionRecallWriteRequest) => Promise<IpcResult<SessionRecallEntry>>;
    sessionSearch: (request: SessionSearchRequest) => Promise<IpcResult<SessionSearchResult>>;
    delete: (id: string) => Promise<IpcResult<MemoryDeleteResult>>;
    restore: (id: string) => Promise<IpcResult<MemoryDeleteResult>>;
  };
  mcp: {
    listServers: () => Promise<IpcResult<McpServerSnapshot[]>>;
    ensureExaPreset: () => Promise<IpcResult<McpServerConfig>>;
    upsertServer: (server: McpServerConfig) => Promise<IpcResult<McpServerConfig>>;
    setServerEnabled: (request: { id: string; enabled: boolean }) => Promise<IpcResult<McpServerConfig>>;
    setServerApprovalMode: (request: { id: string; approvalMode: McpServerConfig['approvalMode'] }) => Promise<IpcResult<McpServerConfig>>;
    deleteServer: (id: string) => Promise<IpcResult<{ deleted: true }>>;
    testServer: (id: string) => Promise<IpcResult<McpServerTestResult>>;
  };
  skills: {
    list: () => Promise<IpcResult<SkillSnapshot[]>>;
    importSkill: (request: SkillImportRequest) => Promise<IpcResult<SkillSnapshot>>;
    setEnabled: (request: { id: string; enabled: boolean }) => Promise<IpcResult<SkillSnapshot>>;
    deleteSkill: (id: string) => Promise<IpcResult<{ deleted: true }>>;
    listFiles: (request: SkillFileTreeRequest) => Promise<IpcResult<SkillFileTreeResult>>;
    readFile: (request: SkillFilePreviewRequest) => Promise<IpcResult<SkillFilePreviewResult>>;
  };
  settings: {
    get: () => Promise<IpcResult<SettingsSnapshot>>;
    save: (settings: SettingsSaveRequest) => Promise<IpcResult<SettingsSnapshot>>;
    testProvider: (id: string) => Promise<IpcResult<ProviderTestResult>>;
    setProviderSecret: (request: ProviderSecretSetRequest) => Promise<IpcResult<ProviderSecretSetResult>>;
    clearProviderSecret: (providerId: string) => Promise<IpcResult<ProviderSecretClearResult>>;
  };
  doctor: {
    getLatest: () => Promise<IpcResult<DoctorSnapshot>>;
    run: () => Promise<IpcResult<DoctorSnapshot>>;
  };
  agent: {
    getStatus: () => Promise<IpcResult<AgentRuntimeStatus>>;
    getConfigPreview: () => Promise<IpcResult<DeepAgentConfigPreview>>;
    getCapabilityPreview: (request: ChatStartRunRequest['enabledCapabilities']) => Promise<IpcResult<AgentCapabilityPreview>>;
  };
  chat: {
    startRun: (request: ChatStartRunRequest) => Promise<IpcResult<ChatStartRunResult>>;
    cancelRun: (runId: string) => Promise<IpcResult<ChatCancelRunResult>>;
    resumeRun: (request: ChatResumeRunRequest) => Promise<IpcResult<ChatResumeRunResult>>;
    onRunEvent: (callback: (event: ChatRunEvent) => void) => () => void;
  };
  workspace: {
    getCurrent: () => Promise<IpcResult<Workspace | null>>;
    select: (request: WorkspaceSelectRequest) => Promise<IpcResult<Workspace>>;
    selectFromDialog: () => Promise<IpcResult<Workspace | null>>;
  };
  files: {
    selectFromDialog: () => Promise<IpcResult<FileDialogSelection | null>>;
    listTree: (request: FileTreeRequest) => Promise<IpcResult<FileTreeResult>>;
    search: (request: FileSearchRequest) => Promise<IpcResult<FileSearchResult>>;
    preview: (request: FilePreviewRequest) => Promise<IpcResult<FilePreviewResult>>;
    writeText: (request: FileWriteTextRequest) => Promise<IpcResult<FileWriteResult>>;
  };
  git: {
    status: () => Promise<IpcResult<GitStatusResult>>;
    diffStat: () => Promise<IpcResult<GitDiffStatResult>>;
    fileDiff: (request: GitFileOperationRequest) => Promise<IpcResult<GitFileDiffResult>>;
    stageFile: (request: GitFileOperationRequest) => Promise<IpcResult<GitStatusResult>>;
    stageFiles: (request: GitBatchFileOperationRequest) => Promise<IpcResult<GitStatusResult>>;
    unstageFile: (request: GitFileOperationRequest) => Promise<IpcResult<GitStatusResult>>;
    discardFile: (request: GitFileOperationRequest) => Promise<IpcResult<GitStatusResult>>;
    commit: (request: GitCommitRequest) => Promise<IpcResult<GitCommitResult>>;
    push: () => Promise<IpcResult<GitPushResult>>;
    listBranches: () => Promise<IpcResult<GitBranchListResult>>;
    createBranch: (request: GitCreateBranchRequest) => Promise<IpcResult<GitBranchMutationResult>>;
    checkoutBranch: (request: GitCheckoutBranchRequest) => Promise<IpcResult<GitBranchMutationResult>>;
  };
  terminal: {
    createSession: (request: TerminalSessionCreateRequest) => Promise<IpcResult<TerminalSessionSnapshot>>;
    writeInput: (request: TerminalSessionInputRequest) => Promise<IpcResult<{ delivered: true }>>;
    resize: (request: TerminalSessionResizeRequest) => Promise<IpcResult<TerminalSessionSnapshot>>;
    closeSession: (request: TerminalSessionCloseRequest) => Promise<IpcResult<{ closed: true }>>;
    onOutput: (callback: (event: TerminalSessionOutputEvent) => void) => () => void;
    onExit: (callback: (event: TerminalSessionExitEvent) => void) => () => void;
  };
  rtk: {
    status: () => Promise<IpcResult<RtkStatus>>;
  };
  shell: {
    execute: (request: ShellExecutionRequest) => Promise<IpcResult<ShellExecutionResult>>;
  };
};
