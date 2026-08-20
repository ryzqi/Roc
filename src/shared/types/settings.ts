import type { z } from 'zod';

import { defaultModelStateSchema } from '../schemas/agent';
import {
  appSettingsSchema,
  hostIntegrationStatusSchema,
  permissionsConfigSchema,
  providerConfigSchema,
  providerConnectionOptionsSchema,
  providerModelSchema,
  providerModelOptionsSchema,
  providerSecretClearResultSchema,
  providerSecretSetRequestSchema,
  providerSecretSetResultSchema,
  providerSecretStatusSchema,
  providersConfigSchema,
  providerTestResultSchema,
  providerTestRequestSchema,
  settingsDocumentSchema,
  settingsSaveHookConfigRequestSchema,
  settingsSaveRequestSchema,
  settingsSnapshotSchema,
  settingsTrustHookRequestSchema,
  shortcutsConfigSchema
} from '../schemas/ipc-memory-settings';
import { approvalModeSchema, mcpServersConfigSchema } from '../schemas/ipc-mcp-skills';

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type MemoryCharLimits = AppSettings['memory']['charLimits'];
export type MemorySecurityScanSettings = AppSettings['memory']['securityScan'];
export type AutoMemorySettings = AppSettings['memory']['autoMemory'];

export type ApprovalMode = z.infer<typeof approvalModeSchema>;
export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;
export type ShortcutsConfig = z.infer<typeof shortcutsConfigSchema>;

export type ProviderType = z.infer<typeof providerConfigSchema>['type'];
type ParsedProviderModel = z.infer<typeof providerModelSchema>;
export type ProviderConnectionOptions = z.infer<typeof providerConnectionOptionsSchema>;
export type ProviderModelOptions = z.infer<typeof providerModelOptionsSchema>;
export type ProviderModel = Omit<ParsedProviderModel, 'options'> & { options?: ProviderModelOptions };
type ParsedProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderConfig = ParsedProviderConfig;
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>;
export type ProviderTestRequest = z.infer<typeof providerTestRequestSchema>;
type ParsedProvidersConfig = z.infer<typeof providersConfigSchema>;
export type ProvidersConfig = Omit<ParsedProvidersConfig, 'schemaVersion' | 'providers'> & {
  schemaVersion: number;
  providers: ProviderConfig[];
};
export type McpServersConfig = z.infer<typeof mcpServersConfigSchema>;

export type NvidiaToolChoice = NonNullable<ProviderModelOptions['toolChoice']>;
export type ProviderSamplingProfileOverrides = NonNullable<ProviderModelOptions['samplingProfileOverrides']>;
export type AnthropicThinkingOption = NonNullable<ProviderModelOptions['anthropicThinking']>;
export type OpenAiReasoningOption = NonNullable<ProviderModelOptions['reasoning']>;
export type OpenAiReasoningEffort = NonNullable<OpenAiReasoningOption['effort']>;
export type OpenAiReasoningSummary = NonNullable<OpenAiReasoningOption['summary']>;
export type OpenAiServiceTier = NonNullable<ProviderModelOptions['serviceTier']>;
export type OpenAiVerbosity = NonNullable<ProviderModelOptions['verbosity']>;

export const anthropicThinkingMinBudgetTokens = 1024;

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

type ParsedSettingsDocument = z.infer<typeof settingsDocumentSchema>;
export type RocSettingsDocument = Omit<ParsedSettingsDocument, 'providers'> & { providers: ProvidersConfig };

export type DefaultModelState = z.infer<typeof defaultModelStateSchema>;

export type ProviderSecretStatus = z.infer<typeof providerSecretStatusSchema>;
export type HostIntegrationStatus = z.infer<typeof hostIntegrationStatusSchema>;
type ParsedSettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;
export type SettingsSnapshot = Omit<ParsedSettingsSnapshot, 'providers'> & { providers: ProviderConfig[] };
type ParsedSettingsSaveRequest = z.infer<typeof settingsSaveRequestSchema>;
export type SettingsSaveRequest = Omit<ParsedSettingsSaveRequest, 'providers'> & { providers: ProviderConfig[] };
export type SettingsSaveHookConfigRequest = z.infer<typeof settingsSaveHookConfigRequestSchema>;
export type SettingsTrustHookRequest = z.infer<typeof settingsTrustHookRequestSchema>;
export type ProviderSecretSetRequest = z.infer<typeof providerSecretSetRequestSchema>;
export type ProviderSecretSetResult = z.infer<typeof providerSecretSetResultSchema>;
export type ProviderSecretClearResult = z.infer<typeof providerSecretClearResultSchema>;
