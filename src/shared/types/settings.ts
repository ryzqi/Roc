import type {
  MemoryCandidateReviewMode,
  MemoryColdAutoForgetDays,
  MemoryCrossScopeRecall,
  MemorySessionRetentionDays
} from './memory';
import type { McpServerConfig, McpServerSnapshot } from './mcp';
import type { SkillSnapshot } from './skill';

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
  tasks: {
    longRunningThresholds: {
      runningSeconds: number;
      toolCallCount: number;
      subagentCount: number;
    };
    scheduler: {
      catchUpOnStartup: boolean;
      maxRegisteredTasks: number;
    };
  };
};

export type ApprovalMode = 'fully_automatic' | 'default';

export type PermissionsConfig = {
  schemaVersion: 3;
  mode: ApprovalMode;
  grants: unknown[];
};

export type ShortcutsConfig = {
  schemaVersion: 1;
  shortcuts: unknown[];
};

export type ProviderType = 'openai_compatible' | 'anthropic_compatible' | 'nvidia' | 'llama_cpp' | 'ollama' | 'custom';

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
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
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
  schemaVersion: 4;
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
