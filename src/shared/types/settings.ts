import type { z } from 'zod';

import { defaultModelStateSchema } from '../schemas/agent';
import {
  appSettingsSchema,
  hostIntegrationStatusSchema,
  permissionsConfigSchema,
  providerConfigSchema,
  providerModelSchema,
  providerOptionsSchema,
  providerSecretClearResultSchema,
  providerSecretSetRequestSchema,
  providerSecretSetResultSchema,
  providerSecretStatusSchema,
  providersConfigSchema,
  providerTestResultSchema,
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

export type ProviderOptions = z.infer<typeof providerOptionsSchema>;
export type ProviderType = z.infer<typeof providerConfigSchema>['type'];
export type ProviderModel = z.infer<typeof providerModelSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>;
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;
export type McpServersConfig = z.infer<typeof mcpServersConfigSchema>;

export type NvidiaToolChoice = NonNullable<ProviderOptions['toolChoice']>;
export type ProviderSamplingProfileOverrides = NonNullable<ProviderOptions['samplingProfileOverrides']>;
export type AnthropicThinkingOption = NonNullable<ProviderOptions['anthropicThinking']>;
export type OpenAiReasoningOption = NonNullable<ProviderOptions['reasoning']>;
export type OpenAiReasoningEffort = NonNullable<OpenAiReasoningOption['effort']>;
export type OpenAiReasoningSummary = NonNullable<OpenAiReasoningOption['summary']>;
export type OpenAiServiceTier = NonNullable<ProviderOptions['serviceTier']>;
export type OpenAiVerbosity = NonNullable<ProviderOptions['verbosity']>;

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

export type RocSettingsDocument = z.infer<typeof settingsDocumentSchema>;

export type DefaultModelState = z.infer<typeof defaultModelStateSchema>;

export type ProviderSecretStatus = z.infer<typeof providerSecretStatusSchema>;
export type HostIntegrationStatus = z.infer<typeof hostIntegrationStatusSchema>;
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;
export type SettingsSaveRequest = z.infer<typeof settingsSaveRequestSchema>;
export type SettingsSaveHookConfigRequest = z.infer<typeof settingsSaveHookConfigRequestSchema>;
export type SettingsTrustHookRequest = z.infer<typeof settingsTrustHookRequestSchema>;
export type ProviderSecretSetRequest = z.infer<typeof providerSecretSetRequestSchema>;
export type ProviderSecretSetResult = z.infer<typeof providerSecretSetResultSchema>;
export type ProviderSecretClearResult = z.infer<typeof providerSecretClearResultSchema>;
