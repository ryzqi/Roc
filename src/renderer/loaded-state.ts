import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  AppSettings,
  AppStatus,
  BackgroundTask,
  DiagnosticPackage,
  DoctorSnapshot,
  FilePreviewResult,
  FileSearchResult,
  FileTreeResult,
  GitBranchListResult,
  GitCommitResult,
  GitFileDiffResult,
  GitPushResult,
  GitStatusResult,
  McpServerSnapshot,
  McpServerTestResult,
  MemoryCandidate,
  MemoryConflict,
  MemoryDeleteResult,
  MemorySearchResult,
  MemoryStatus,
  PerformanceSample,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult,
  RtkStatus,
  SessionSearchResult,
  SkillSnapshot,
  TaskSnapshot,
  TerminalSessionSnapshot,
  TraySummary,
  Workspace
} from '../shared/types';

export type LoadedState = {
  appStatus: AppStatus;
  taskSnapshot: TaskSnapshot;
  memoryStatus: MemoryStatus;
  memoryCandidates: MemoryCandidate[];
  memoryConflicts: MemoryConflict[];
  memorySearch: MemorySearchResult | null;
  sessionSearch: SessionSearchResult | null;
  memoryRecovery: MemoryDeleteResult | null;
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  providerTestStatus: ProviderTestResult | null;
  mcpServers: McpServerSnapshot[];
  mcpTestStatus: McpServerTestResult | null;
  skills: SkillSnapshot[];
  selectedMcpServers: string[];
  selectedSkills: string[];
  backgroundTask: BackgroundTask | null;
  backgroundTasks: BackgroundTask[];
  traySummary: TraySummary;
  diagnosticPackage: DiagnosticPackage | null;
  performanceSample: PerformanceSample;
  doctor: DoctorSnapshot;
  agent: AgentRuntimeStatus;
  agentCapabilityPreview: AgentCapabilityPreview | null;
  workspace: Workspace | null;
  fileTree: FileTreeResult | null;
  fileSearch: FileSearchResult | null;
  filePreview: FilePreviewResult | null;
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
