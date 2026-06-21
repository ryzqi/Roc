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
  RtkStatus,
  SchedulerStatus,
  ScheduledTaskRun,
  SkillSnapshot,
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

export type IpcLikeResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

export function unwrap<T>(label: string, result: IpcLikeResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(`${label} failed: ${result.error.message}`);
}
