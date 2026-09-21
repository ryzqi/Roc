import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  ActiveTaskItem,
  AppSettings,
  AppStatus,
  DiagnosticPackage,
  DiagnosticCheck,
  FilePreviewResult,
  FilesWorkbenchPdfPreview,
  FileSearchResult,
  FileTreeResult,
  GitBranchListResult,
  GitCommitResult,
  GitFileDiffResult,
  GitPushResult,
  GitStatusResult,
  McpServerSnapshot,
  McpServerTestResult,
  ApprovalMode,
  MemoryStatus,
  PerformanceSample,
  PermissionsConfig,
  ProviderConfig,
  HostIntegrationStatus,
  ProviderSecretStatus,
  ProviderTestResult,
  RocHookConfigSnapshot,
  RtkStatus,
  SchedulerStatus,
  ScheduledTaskRun,
  SkillSnapshot,
  SettingsSnapshot,
  TaskDetail,
  TaskSnapshot,
  TerminalSessionSnapshot,
  TraySummary,
  Workspace
} from '../shared/types';

export type LoadedState = {
  appStatus: AppStatus;
  taskSnapshot: TaskSnapshot;
  memoryStatus: MemoryStatus;
  memoryRecovery: null;
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  hostIntegration: HostIntegrationStatus;
  providerTestStatus: ProviderTestResult | null;
  mcpApprovalMode: ApprovalMode;
  mcpServers: McpServerSnapshot[];
  mcpTestStatus: McpServerTestResult | null;
  skills: SkillSnapshot[];
  hookSettings: RocHookConfigSnapshot;
  selectedMcpServers: string[];
  selectedSkills: string[];
  activeTasks: ActiveTaskItem[];
  taskDetail: TaskDetail | null;
  scheduledRuns: ScheduledTaskRun[];
  schedulerStatus: SchedulerStatus;
  traySummary: TraySummary;
  diagnosticPackage: DiagnosticPackage | null;
  diagnosticChecks: DiagnosticCheck[];
  performanceSample: PerformanceSample;
  agent: AgentRuntimeStatus;
  agentCapabilityPreview: AgentCapabilityPreview | null;
  workspace: Workspace | null;
  fileTree: FileTreeResult | null;
  fileSearch: FileSearchResult | null;
  filePreview: FilePreviewResult | null;
  fileWorkbenchPdfPreview: FilesWorkbenchPdfPreview | null;
  gitStatus: GitStatusResult | null;
  gitBranches: GitBranchListResult | null;
  gitError: string | null;
  gitSelectedPath: string | null;
  gitSelectedPreview: GitFileDiffResult | null;
  gitLastCommit: GitCommitResult | null;
  gitLastPush: GitPushResult | null;
  rtkStatus: RtkStatus;
  terminalError: string | null;
  terminalSession: TerminalSessionSnapshot | null;
};

export type LoadedSettingsState = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
  hookSettings: RocHookConfigSnapshot;
  hostIntegration: HostIntegrationStatus;
  providerTestStatus: ProviderTestResult | null;
  mcpTestStatus: null;
};

export function applySettingsSnapshot(snapshot: SettingsSnapshot): LoadedSettingsState {
  return {
    settings: snapshot.settings,
    providers: snapshot.providers,
    defaultModelId: snapshot.defaultModelId,
    providerSecretStatus: snapshot.providerSecretStatus,
    permissions: snapshot.permissions,
    mcpServers: snapshot.mcpServers,
    skills: snapshot.skills,
    hookSettings: snapshot.hooks,
    hostIntegration: snapshot.hostIntegration,
    providerTestStatus: null,
    mcpTestStatus: null
  };
}

export type IpcLikeResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

export function unwrap<T>(label: string, result: IpcLikeResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(`${label} failed: ${result.error.message}`);
}
