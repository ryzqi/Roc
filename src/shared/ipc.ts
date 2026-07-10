import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  ActiveTaskItem,
  AppStatus,
  ApprovalMode,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatCancelRunResult,
  ChatRunEventsReplayRequest,
  ChatRunEventsReplayResult,
  ChatRunEvent,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatStartRunRequest,
  ChatStartRunResult,
  ActiveChatRun,
  DeepAgentConfigPreview,
  DiagnosticPackage,
  DiagnosticPackageRequest,
  DiagnosticCheck,
  HealthCheckResult,
  FilePreviewRequest,
  FilePreviewResult,
  FilesWorkbenchPdfPreviewRequest,
  FilesWorkbenchPdfPreviewResult,
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
  McpServersConfig,
  MemoryFileWriteOutcome,
  MemoryFileWriteRequest,
  MemoryKind,
  MemoryScope,
  MemoryStatus,
  MetricFilter,
  MetricsSnapshot,
  SessionMessageEntry,
  SessionMessageSearchRequest,
  SessionMessageSearchResult,
  PerformanceSample,
  PerformanceSampleRequest,
  ProviderSecretClearResult,
  ProviderSecretSetRequest,
  ProviderSecretSetResult,
  ProviderTestResult,
  RocHookConfigSnapshot,
  RtkStatus,
  ShellConfirmationRequest,
  ShellConfirmationResult,
  ShellExecutionRequest,
  ShellExecutionResult,
  SettingsSaveRequest,
  SettingsSaveHookConfigRequest,
  SettingsSnapshot,
  SettingsTrustHookRequest,
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
  SchedulerStatus,
  ScheduledTaskRun,
  TaskDetail,
  TaskEvent,
  TaskSnapshot,
  TaskMessageHistoryRequest,
  TaskDeleteThreadRequest,
  TaskDeleteThreadResult,
  TaskUpdateEvent,
  TraySummary,
  SystemAppearanceSnapshot,
  UpdateBackgroundTaskRequest,
  FileDialogSelection,
  Workspace,
  WorkspaceChangedEvent,
  WorkspaceSelectRequest,
  WindowBoundsSnapshot,
  WindowStateSnapshot
} from './types';

export {
  ipcChannels,
  ipcEventChannelKeys,
  ipcRequestChannelKeys,
  ipcSchemaVersion,
  type IpcChannelKey,
  type IpcEventChannelKey,
  type IpcRequestChannelKey
} from './ipc-generated';

export type RocPreloadApi = {
  app: {
    getStatus: () => Promise<IpcResult<AppStatus>>;
    openSettings: () => Promise<IpcResult<{ opened: true }>>;
    openMainPage: (page: string) => Promise<IpcResult<{ opened: true; page: string }>>;
    onAppearanceUpdated: (callback: (appearance: SystemAppearanceSnapshot) => void) => () => void;
    onNavigate: (callback: (page: string) => void) => () => void;
  };
  window: {
    getState: () => Promise<IpcResult<WindowStateSnapshot>>;
    getBounds: () => Promise<IpcResult<WindowBoundsSnapshot>>;
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
    createBackgroundTask: (request: BackgroundTaskPreviewRequest) => Promise<IpcResult<BackgroundTask>>;
    pauseBackgroundTask: (id: string) => Promise<IpcResult<BackgroundTask>>;
    resumeBackgroundTask: (id: string) => Promise<IpcResult<BackgroundTask>>;
    cancelBackgroundTask: (id: string) => Promise<IpcResult<BackgroundTask>>;
    getActiveTasks: () => Promise<IpcResult<ActiveTaskItem[]>>;
    getTaskDetail: (request: { taskId: string }) => Promise<IpcResult<TaskDetail>>;
    listScheduledRuns: (request: { taskId: string; limit?: number }) => Promise<IpcResult<ScheduledTaskRun[]>>;
    runBackgroundNow: (id: string) => Promise<IpcResult<{ taskId: string; runId: string }>>;
    deleteBackgroundTask: (id: string) => Promise<IpcResult<{ deleted: true; taskId: string }>>;
    updateBackgroundTask: (request: UpdateBackgroundTaskRequest) => Promise<IpcResult<BackgroundTask>>;
    getSchedulerStatus: () => Promise<IpcResult<SchedulerStatus>>;
    onUpdated: (callback: (event: TaskUpdateEvent | null) => void) => () => void;
  };
  lifecycle: {
    getTraySummary: () => Promise<IpcResult<TraySummary>>;
    pauseBackgroundExecution: () => Promise<IpcResult<TraySummary>>;
    resumeBackgroundExecution: () => Promise<IpcResult<TraySummary>>;
  };
  diagnostics: {
    samplePerformance: (request: PerformanceSampleRequest) => Promise<IpcResult<PerformanceSample>>;
    createDiagnosticPackage: (request: DiagnosticPackageRequest) => Promise<IpcResult<DiagnosticPackage>>;
    runChecks: () => Promise<IpcResult<DiagnosticCheck[]>>;
    getMetricsSnapshot: (filter?: MetricFilter) => Promise<IpcResult<MetricsSnapshot>>;
    runHealthCheck: () => Promise<IpcResult<HealthCheckResult>>;
  };
  memory: {
    status: () => Promise<IpcResult<MemoryStatus>>;
    readFile: (input: { scope: MemoryScope; kind: MemoryKind }) => Promise<IpcResult<string | null>>;
    writeFile: (request: MemoryFileWriteRequest) => Promise<IpcResult<MemoryFileWriteOutcome>>;
    snapshotPreview: () => Promise<IpcResult<{ text: string }>>;
  };
  sessions: {
    list: (input: { threadId: string; limit?: number }) => Promise<IpcResult<SessionMessageEntry[]>>;
    search: (request: SessionMessageSearchRequest) => Promise<IpcResult<SessionMessageSearchResult>>;
  };
  mcp: {
    listServers: () => Promise<IpcResult<McpServerSnapshot[]>>;
    ensureExaPreset: () => Promise<IpcResult<McpServerConfig>>;
    upsertServer: (server: McpServerConfig) => Promise<IpcResult<McpServerConfig>>;
    setServerEnabled: (request: { id: string; enabled: boolean }) => Promise<IpcResult<McpServerConfig>>;
    deleteServer: (id: string) => Promise<IpcResult<{ deleted: true }>>;
    testServer: (id: string) => Promise<IpcResult<McpServerTestResult>>;
    getConfig: () => Promise<IpcResult<McpServersConfig>>;
    setApprovalMode: (request: { approvalMode: ApprovalMode }) => Promise<IpcResult<McpServersConfig>>;
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
    getHooks: () => Promise<IpcResult<RocHookConfigSnapshot>>;
    saveHooks: (request: SettingsSaveHookConfigRequest) => Promise<IpcResult<RocHookConfigSnapshot>>;
    trustHook: (request: SettingsTrustHookRequest) => Promise<IpcResult<RocHookConfigSnapshot>>;
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
    getRunEvents: (request: ChatRunEventsReplayRequest) => Promise<IpcResult<ChatRunEventsReplayResult>>;
    getActiveRun: (request: { threadId: string }) => Promise<IpcResult<ActiveChatRun | null>>;
    onRunEvent: (callback: (event: ChatRunEvent) => void) => () => void;
  };
  workspace: {
    getCurrent: () => Promise<IpcResult<Workspace | null>>;
    select: (request: WorkspaceSelectRequest) => Promise<IpcResult<Workspace>>;
    selectFromDialog: () => Promise<IpcResult<Workspace | null>>;
    onChanged: (callback: (event: WorkspaceChangedEvent) => void) => () => void;
  };
  files: {
    selectFromDialog: () => Promise<IpcResult<FileDialogSelection | null>>;
    listTree: (request: FileTreeRequest) => Promise<IpcResult<FileTreeResult>>;
    search: (request: FileSearchRequest) => Promise<IpcResult<FileSearchResult>>;
    preview: (request: FilePreviewRequest) => Promise<IpcResult<FilePreviewResult>>;
    previewPdf: (request: FilesWorkbenchPdfPreviewRequest) => Promise<IpcResult<FilesWorkbenchPdfPreviewResult>>;
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
    confirm: (request: ShellConfirmationRequest) => Promise<IpcResult<ShellConfirmationResult>>;
  };
};
