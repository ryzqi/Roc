export type RocRunMode = 'development' | 'packaged' | 'smoke' | 'test';

export type RocErrorCategory =
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'external'
  | 'degraded'
  | 'internal';

export type RocError = {
  code: string;
  message: string;
  category: RocErrorCategory;
  retryable: boolean;
  userAction?: string;
  auditEventId?: string;
};

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: RocError };

export type ServiceStatus = 'ready' | 'blocked' | 'degraded';

export type RocPathsSnapshot = {
  root: string;
  configDir: string;
  databasePath: string;
  memoryDir: string;
  logsDir: string;
  diagnosticsDir: string;
  skillsDir: string;
  artifactsDir: string;
};

export type AppStatus = {
  appName: string;
  version: string;
  mode: RocRunMode;
  startedAt: string;
  workspace: {
    selectedPath: string | null;
    label: string;
  };
  paths: RocPathsSnapshot;
  services: Record<string, ServiceStatus>;
  defaultModelConfigured: boolean;
  rendererBoundary: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
  };
};

export type WindowStateSnapshot = {
  maximized: boolean;
  minimized: boolean;
  fullscreen: boolean;
};

export type WindowBoundsSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkspaceTrustState = 'trusted' | 'limited' | 'blocked';

export type Workspace = {
  id: string;
  path: string;
  displayName: string;
  lastOpenedAt: string;
  trustState: WorkspaceTrustState;
  defaultShell?: string;
};

export type WorkspaceSelectRequest = {
  path: string;
};

export type FileDialogSelection = {
  filePaths: string[];
};

export type FileEntry = {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  size: number;
  updatedAt: string;
};

export type FileTreeRequest = {
  relativePath: string;
  limit?: number;
};

export type FileTreeResult = {
  workspacePath: string;
  relativePath: string;
  entries: FileEntry[];
  truncated: boolean;
};

export type FileSearchRequest = {
  query: string;
  maxResults?: number;
};

export type FileSearchMatch = {
  relativePath: string;
  line: number;
  column: number;
  preview: string;
};

export type FileSearchResult = {
  query: string;
  matches: FileSearchMatch[];
  truncated: boolean;
};

export type FilePreviewRequest = {
  relativePath: string;
  maxBytes?: number;
};

export type FilePreviewResult = {
  relativePath: string;
  kind: 'text' | 'image' | 'binary';
  content: string;
  truncated: boolean;
  sizeBytes: number;
  mediaType?: string;
};

export type FileWriteTextRequest = {
  relativePath: string;
  content: string;
  source: string;
  threadId?: string;
  runId?: string;
};

export type RecoveryPoint = {
  id: string;
  relativePath: string;
  snapshotPath: string;
  contentSha256: string;
  source: string;
  createdAt: string;
  restored: boolean;
};

export type FileWriteResult = {
  relativePath: string;
  recoveryPoint: RecoveryPoint;
  bytesWritten: number;
};

export type GitStatusResult = {
  workspacePath: string;
  isRepository: true;
  branch: string;
  porcelain: string[];
  changes: GitStatusChange[];
  changedFiles: number;
};

export type GitStatusChange = {
  porcelain: string;
  index: string;
  worktree: string;
  relativePath: string;
  originalPath?: string;
};

export type GitDiffStatResult = {
  workspacePath: string;
  stat: string;
};

export type GitFileDiffResult = {
  workspacePath: string;
  relativePath: string;
  patch: string;
};

export type GitFileOperationRequest = {
  relativePath: string;
};

export type GitBatchFileOperationRequest = {
  relativePaths: string[];
};

export type GitCommitRequest = {
  message: string;
};

export type GitBranchSummary = {
  name: string;
  current: boolean;
};

export type GitBranchListResult = {
  workspacePath: string;
  currentBranch: string;
  branches: GitBranchSummary[];
};

export type GitCreateBranchRequest = {
  name: string;
  checkoutAfterCreate: boolean;
};

export type GitCheckoutBranchRequest = {
  name: string;
};

export type GitBranchMutationResult = {
  workspacePath: string;
  branchInfo: GitBranchListResult;
  status: GitStatusResult;
};

export type GitCommitResult = {
  workspacePath: string;
  commitMessage: string;
  commitSha: string;
  status: GitStatusResult;
};

export type GitPushResult = {
  workspacePath: string;
  remoteName: string;
  branch: string;
  status: GitStatusResult;
  output: string;
};

export type RtkBypassReason =
  | 'rtk_binary_missing'
  | 'user_terminal_raw_output'
  | 'command_not_supported'
  | 'command_requires_confirmation';

export type RtkStatus = {
  enabledForAgentCommands: boolean;
  binaryPath: string;
  configPath: string;
  teeDir: string;
  resourceState: 'ready' | 'missing';
  bypassReason?: RtkBypassReason;
};

export type ShellCommandSource = 'agent' | 'terminal';
export type ShellCommandRisk = 'low' | 'medium' | 'high';

export type ShellExecutionRequest = {
  command: string;
  cwd?: string;
  source: ShellCommandSource;
  threadId?: string;
  runId?: string;
};

export type ShellExecutionDecision =
  | {
      status: 'allowed';
      riskLevel: 'low';
      normalizedCommand: string;
    }
  | {
      status: 'requires_confirmation';
      reason: 'workspace_outside' | 'high_risk_command' | 'unknown_command';
      riskLevel: Exclude<ShellCommandRisk, 'low'>;
      normalizedCommand: string;
    };

export type ShellExecutionResult = {
  command: string;
  normalizedCommand: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  usedRtk: boolean;
  rtkVersion?: string;
  teePath?: string;
  bypassReason?: RtkBypassReason;
};

export type TerminalSessionId = string;
export type TerminalSessionStatus = 'starting' | 'ready' | 'exited' | 'error';

export type TerminalSessionCreateRequest = {
  cwd?: string;
  cols: number;
  rows: number;
};

export type TerminalSessionSnapshot = {
  id: TerminalSessionId;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: TerminalSessionStatus;
  exitCode: number | null;
};

export type TerminalSessionInputRequest = {
  sessionId: TerminalSessionId;
  data: string;
};

export type TerminalSessionResizeRequest = {
  sessionId: TerminalSessionId;
  cols: number;
  rows: number;
};

export type TerminalSessionCloseRequest = {
  sessionId: TerminalSessionId;
};

export type TerminalSessionOutputEvent = {
  sessionId: TerminalSessionId;
  data: string;
};

export type TerminalSessionExitEvent = {
  sessionId: TerminalSessionId;
  exitCode: number | null;
};

export type TaskStatus =
  | 'draft'
  | 'pending_confirmation'
  | 'running'
  | 'paused'
  | 'waiting_user'
  | 'waiting_next_turn'
  | 'failed'
  | 'cancelled'
  | 'completed'
  | 'archived';

export type TaskThread = {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type TaskEvent = {
  id: string;
  threadId: string;
  runId: string;
  type:
    | 'message'
    | 'message_delta'
    | 'agent_update'
    | 'plan'
    | 'tool_call'
    | 'mcp_call'
    | 'skill_loaded'
    | 'subagent_started'
    | 'subagent_completed'
    | 'terminal_command'
    | 'file_change'
    | 'git_operation'
    | 'memory_operation'
    | 'approval_requested'
    | 'approval_decision'
    | 'recovery_point'
    | 'context_manifest'
    | 'background_task_created'
    | 'background_task_paused'
    | 'background_task_resumed'
    | 'background_task_cancelled'
    | 'diagnostic'
    | 'verification'
    | 'error'
    | 'summary';
  payload: unknown;
  createdAt: string;
};

export type TaskSnapshot = {
  generatedAt: string;
  counts: {
    total: number;
    running: number;
    failed: number;
    pendingConfirmation: number;
  };
  threads: TaskThread[];
  recentEvents: TaskEvent[];
};

export type TaskRun = {
  id: string;
  threadId: string;
  runNumber: number;
  userInput: string;
  status: TaskStatus;
  startedAt: string;
  endedAt: string | null;
  modelId: string | null;
  enabledCapabilities: EnabledCapabilities;
};

export type TaskDeleteThreadRequest = {
  threadId: string;
};

export type TaskDeleteThreadResult = {
  deleted: true;
  threadId: string;
};

export type BackgroundTaskTrigger = {
  type: 'manual' | 'schedule';
  description: string;
  nextRunAt: string | null;
};

export type BackgroundTaskPreviewRequest = {
  goal: string;
  trigger: BackgroundTaskTrigger;
  workspacePath: string;
  allowedActions: string[];
  forbiddenActions: string[];
  failurePolicy: 'pause_and_report';
  notificationPolicy: 'failures_and_confirmations';
};

export type BackgroundTaskPreview = BackgroundTaskPreviewRequest & {
  scheduled: boolean;
  nextRunAt: string | null;
  riskLevel: ShellCommandRisk;
  requiresConfirmation: boolean;
};

export type BackgroundTask = {
  id: string;
  threadId: string;
  runId: string;
  goal: string;
  status: TaskStatus;
  scheduled: boolean;
  triggerDescription: string;
  nextRunAt: string | null;
  workspacePath: string;
  allowedActions: string[];
  forbiddenActions: string[];
  failurePolicy: 'pause_and_report';
  notificationPolicy: 'failures_and_confirmations';
  riskLevel: ShellCommandRisk;
  requiresConfirmation: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BackgroundTaskSummary = {
  total: number;
  running: number;
  failed: number;
  pendingConfirmation: number;
  nextRunAt: string | null;
};

export type TraySummary = {
  residentEnabled: boolean;
  backgroundPaused: boolean;
  backgroundTasks: BackgroundTaskSummary;
  nextRunAt: string | null;
  updatedAt: string;
};

export type MemoryCandidateReviewMode = 'manual' | 'auto_after_approval';
export type MemorySessionRetentionDays = 30 | 90 | 180;
export type MemoryCrossScopeRecall = 'explicit_only' | 'expanded_with_label';
export type MemoryColdAutoForgetDays = 90 | 180 | 365 | null;

export type AppSettings = {
  schemaVersion: 2;
  defaultWorkspace: string | null;
  startup: {
    openAtLogin: boolean;
    minimizeToTray: boolean;
  };
  notifications: {
    lowDistraction: boolean;
  };
  globalHotkey: string | null;
  memory: {
    candidateReviewMode: MemoryCandidateReviewMode;
    warmRecallEnabled: boolean;
    sessionRetentionDays: MemorySessionRetentionDays;
    crossScopeRecall: MemoryCrossScopeRecall;
    coldAutoForgetDays: MemoryColdAutoForgetDays;
  };
};

export type PermissionConfirmationPolicy = 'always_confirm' | 'never_confirm';

export type PermissionsConfig = {
  schemaVersion: 2;
  defaultConfirmations: {
    workspaceOutsideWrite: PermissionConfirmationPolicy;
    gitPush: PermissionConfirmationPolicy;
    memoryDelete: PermissionConfirmationPolicy;
    workspaceOutsideShell: PermissionConfirmationPolicy;
  };
  grants: unknown[];
};

export type ShortcutsConfig = {
  schemaVersion: 1;
  shortcuts: unknown[];
};

export type ProviderType = 'openai_compatible' | 'anthropic_compatible' | 'nvidia' | 'ollama' | 'custom';

export type ProviderOptions = {
  temperature?: number;
  maxTokens?: number;
  thinking?: boolean;
};

export type ProviderModel = {
  id: string;
  displayName: string;
  enabled: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
};

export type ProviderConfig = {
  id: string;
  name: string;
  type: ProviderType;
  endpoint: string;
  credentialRef: string | null;
  enabled: boolean;
  models: ProviderModel[];
  options?: ProviderOptions;
};

export type ProviderTestResult = {
  providerId: string;
  status: 'ready' | 'invalid';
  defaultModelReady: boolean;
  checked: string[];
  modelId?: string | null;
  error: string | null;
};

export type ProviderExecutionUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  promptCharacters: number;
  completionCharacters: number;
};

export type ProviderExecutionResult = {
  providerId: string;
  modelId: string;
  assistantMessage: string;
  createdAt: string;
  durationMs: number;
  finishReason: string;
  usage: ProviderExecutionUsage;
  summary: string;
};

export type ProvidersConfig = {
  schemaVersion: 1;
  defaultModelId: string | null;
  providers: ProviderConfig[];
};

export type McpServersConfig = {
  schemaVersion: 1;
  servers: McpServerConfig[];
};

export type RocSettingsDocument = {
  schemaVersion: 3;
  settings: AppSettings;
  providers: ProvidersConfig;
  mcp: McpServersConfig;
  permissions: PermissionsConfig;
  shortcuts: ShortcutsConfig;
};

export type DefaultModelState = {
  status: 'missing' | 'invalid' | 'ready';
  modelId: string | null;
  providerId: string | null;
  reason: string;
};

export type EnabledCapabilities = {
  mcpServers: string[];
  skills: string[];
};

export type ChatRunMode = 'chat' | 'task';

export type ChatTodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type ChatToolEventStatus = 'start' | 'progress' | 'end' | 'error';

export type ChatRunEvent =
  | {
      type: 'run_started';
      runId: string;
      mode: ChatRunMode;
      threadId: string | null;
      providerId: string;
      modelId: string;
      createdAt: string;
    }
  | {
      type: 'message_delta';
      runId: string;
      delta: string;
    }
  | {
      type: 'reasoning_delta';
      runId: string;
      delta: string;
    }
  | {
      type: 'tool_event';
      runId: string;
      event: ChatToolEventStatus;
      name: string;
      data: unknown;
    }
  | {
      type: 'todo_event';
      runId: string;
      todos: ChatTodoItem[];
    }
  | {
      type: 'subagent_event';
      runId: string;
      subagent: string;
      status: 'started' | 'completed' | 'failed';
      summary: string | null;
    }
  | {
      type: 'run_completed';
      runId: string;
      threadId: string | null;
      providerId: string;
      modelId: string;
      createdAt: string;
      durationMs: number;
      summary: string;
      assistantMessage: string;
    }
  | {
      type: 'run_failed';
      runId: string;
      threadId: string | null;
      code: string;
      message: string;
      retryable: boolean;
    };

export type ChatStartRunRequest = {
  input: string;
  mode: ChatRunMode;
  enabledCapabilities: EnabledCapabilities;
  threadId?: string | null;
};

export type ChatStartRunResult = {
  runId: string;
  mode: ChatRunMode;
  threadId: string | null;
  providerId: string;
  modelId: string;
  createdAt: string;
};

export type ChatCancelRunResult = {
  runId: string;
  cancelled: boolean;
};

export type DeepAgentConfigPreview = {
  runnable: false;
  model: string;
  memoryAccess: 'memory_service_only';
  builtInTools: string[];
  rocTools: string[];
  todoMapping: {
    sourceTool: 'write_todos';
    target: 'task_steps';
  };
  interruptOn: Record<string, boolean>;
  reason: string;
};

export type AgentCapabilityType = 'memory_tool' | 'mcp_tool' | 'web_read' | 'skill' | 'subagent';
export type AgentCapabilityScope = 'app' | 'workspace' | 'memory' | 'network' | 'external';
export type AgentCapabilityRisk = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type AgentCapabilityCard = {
  id: string;
  name: string;
  capabilityType: AgentCapabilityType;
  description: string;
  requiredInput: string;
  scope: AgentCapabilityScope;
  dependencies: string[];
  sideEffects: string[];
  requiresApproval: boolean;
  supportsLongTermGrant: boolean;
  revokeGrantHint: string;
  riskLevel: AgentCapabilityRisk;
  auditCategory: string;
  untrustedContext: boolean;
  sourcePath?: string;
};

export type SkippedCapability = {
  id: string;
  type: 'mcp_server' | 'skill';
  reason: 'not_found' | 'disabled' | 'invalid';
};

export type AgentSubagentPreview = {
  id: string;
  name: string;
  purpose: string;
  inheritsSkills: false;
  tools: string[];
};

export type AgentCapabilityPreview = {
  runnable: false;
  modelId: string;
  builtInTools: string[];
  selectedCapabilities: EnabledCapabilities;
  requestedCapabilities: EnabledCapabilities;
  skippedCapabilities: SkippedCapability[];
  toolCards: AgentCapabilityCard[];
  skillCards: AgentCapabilityCard[];
  subagents: AgentSubagentPreview[];
  interruptOn: Record<string, boolean>;
  untrustedContextPolicy: 'external_content_reference_only';
  reason: string;
};

export type AgentCapabilityManifest = {
  requestedCapabilities: EnabledCapabilities;
  resolvedCapabilities: EnabledCapabilities;
  skippedCapabilities: SkippedCapability[];
  toolCards: Array<Pick<AgentCapabilityCard, 'id' | 'name' | 'capabilityType' | 'riskLevel' | 'scope' | 'requiresApproval'>>;
  untrustedContextPolicy: 'external_content_reference_only';
};

export type MemoryLayer = 'hot' | 'warm' | 'cold' | 'session' | 'candidate';
export type MemoryType = 'preference' | 'feedback' | 'project_context' | 'process_skill' | 'knowledge_note' | 'session_recall';
export type MemoryPriority = 'critical' | 'high' | 'medium' | 'low';
export type MemoryEntryStatus = 'active' | 'candidate' | 'superseded' | 'stale' | 'archived';
export type MemoryCandidateState =
  | 'new'
  | 'needs_review'
  | 'conflict_detected'
  | 'accepted'
  | 'rejected'
  | 'merged'
  | 'expired';

export type MemoryEntry = {
  id: string;
  layer: MemoryLayer;
  type: MemoryType;
  scope: string;
  content: string;
  confidence: number;
  priority: MemoryPriority;
  status: MemoryEntryStatus;
  source: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryFullTextIndexStatus = {
  enabled: boolean;
  healthy: boolean;
  status: 'ready' | 'degraded';
};

export type MemoryStatus = {
  root: string;
  truthSource: 'markdown';
  indexSource: 'sqlite';
  vectorIndex: {
    enabled: boolean;
    healthy: boolean;
    status: 'not_configured' | 'ready' | 'degraded';
  };
  fullTextIndex: MemoryFullTextIndexStatus;
  layers: Record<MemoryLayer, { entries: number; characters: number; path: string }>;
  degradedReason?: string;
};

export type MemorySearchRequest = {
  query: string;
  includeCold?: boolean;
  source?: 'curated' | 'session' | 'all';
  scope?: string;
};

export type MemorySearchResult = {
  query: string;
  degraded: boolean;
  degradedReason?: string;
  items: Array<{
    id: string;
    layer: MemoryLayer;
    scope: string;
    confidence: number;
    sourceRef: string;
    reason: string;
    summary: string;
  }>;
};

export type MemoryCandidate = {
  id: string;
  state: MemoryCandidateState;
  type: MemoryType;
  scope: string;
  content: string;
  confidence: number;
  priority: MemoryPriority;
  source: string;
  sourceRef: string;
  suggestedAction: 'accept' | 'review_conflict' | 'none';
  conflictCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryConflict = {
  id: string;
  candidateId: string;
  activeMemoryId: string;
  type: MemoryType;
  scope: string;
  reason: string;
  status: 'open' | 'resolved';
  createdAt: string;
};

export type SessionRecallEntry = {
  id: string;
  title: string;
  summary: string;
  scope: string;
  sourceRef: string;
  markdownPath: string;
  createdAt: string;
};

export type SessionRecallWriteRequest = {
  sessionId: string;
  title: string;
  summary: string;
  scope: string;
  content: string;
  sourceRef: string;
};

export type SessionSearchRequest = {
  query: string;
  scope?: string;
};

export type SessionSearchResult = {
  query: string;
  items: Array<{
    id: string;
    title: string;
    summary: string;
    scope: string;
    sourceRef: string;
    reason: string;
  }>;
};

export type MemoryDeleteResult = {
  id: string;
  status: MemoryEntryStatus;
  recoverable: boolean;
};

export type McpServerSnapshot = {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse';
  status: 'not_connected' | 'ready' | 'error';
  tools: number;
  preset?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  url?: string;
  command?: string;
  allowedTools?: string[];
  lastError?: string | null;
};

export type McpServerConfig = {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse';
  preset: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  url?: string;
  command?: string;
  allowedTools: string[];
};

export type McpServerTestResult = {
  serverId: string;
  status: 'ready' | 'invalid';
  checked: string[];
  error: string | null;
};

export type SkillSnapshot = {
  id: string;
  name: string;
  enabled: boolean;
  path: string;
  description: string;
  status: 'ready' | 'invalid';
  lastError?: string | null;
};

export type ProviderSecretStatus = {
  providerId: string;
  stored: boolean;
};

export type SettingsSnapshot = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
};

export type SettingsSaveRequest = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  permissions: PermissionsConfig;
};

export type ProviderSecretSetRequest = {
  providerId: string;
  plaintext: string;
};

export type ProviderSecretSetResult = {
  providerId: string;
  stored: true;
};

export type ProviderSecretClearResult = {
  providerId: string;
  stored: false;
};

export type SkillImportRequest = {
  sourcePath: string;
  id: string;
};

export type DoctorFinding = {
  id: string;
  checkId: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  status: 'pass' | 'fail' | 'degraded' | 'skipped';
  title: string;
  detail: string;
  repairAction?: DoctorRepairAction;
  createdAt: string;
};

export type DoctorRepairAction = {
  label: string;
  action: string;
};

export type DoctorSnapshot = {
  generatedAt: string;
  summary: {
    pass: number;
    fail: number;
    degraded: number;
    skipped: number;
  };
  findings: DoctorFinding[];
};

export type PerformanceSample = {
  id: string;
  sampledAt: string;
  mode: RocRunMode;
  uptimeSeconds: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  memoryBudgetMb: number;
  exceedsBudget: boolean;
};

export type PerformanceSampleRequest = {
  mode: RocRunMode;
  memoryBudgetMb: number;
};

export type DiagnosticPackageRequest = {
  taskId: string;
  errorSummary: string;
};

export type DiagnosticPackage = {
  id: string;
  taskId: string;
  path: string;
  createdAt: string;
  includes: string[];
  redacted: boolean;
};

export type AgentRuntimeStatus = {
  deepAgentsPackage: 'available' | 'missing';
  deepAgentsApi: {
    createDeepAgent: boolean;
  };
  defaultModelConfigured: boolean;
  defaultModelState: DefaultModelState;
  memoryAccess: 'memory_service_only';
  execution: 'blocked_until_provider_configured' | 'ready';
};
