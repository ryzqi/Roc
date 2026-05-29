import { z } from 'zod';
import type {
  AppSettings,
  McpServerConfig,
  McpServersConfig,
  PermissionsConfig,
  ProviderConfig,
  ProvidersConfig,
  RocSettingsDocument,
  SettingsSaveRequest,
  ShortcutsConfig
} from '../../../shared/types';

export const PROVIDER_CREDENTIAL_REF_PATTERN = /^secret:[A-Za-z0-9_-]+$/;

export const SettingsSchema: z.ZodType<AppSettings> = z.object({
  schemaVersion: z.literal(2),
  defaultWorkspace: z.string().nullable(),
  startup: z.object({
    openAtLogin: z.boolean(),
    minimizeToTray: z.boolean()
  }),
  notifications: z.object({
    lowDistraction: z.boolean()
  }),
  globalHotkey: z.string().nullable(),
  memory: z.object({
    frozenSnapshotEnabled: z.boolean(),
    userProfileEnabled: z.boolean(),
    agentsRulesEnabled: z.boolean(),
    charLimits: z.object({
      user: z.number().int().positive(),
      agents: z.number().int().positive(),
      memory: z.number().int().positive()
    }),
    sessionRetentionDays: z.number().int().positive(),
    consolidatorEnabled: z.boolean(),
    consolidatorDebounceMinutes: z.number().int().positive(),
    consolidatorTargetRatio: z.number().min(0).max(1),
    consolidatorDailyQuota: z.number().int().positive(),
    preCompactionFlushEnabled: z.boolean(),
    preCompactionTokenThreshold: z.number().min(0).max(1),
    preCompactionContextWindowTokens: z.number().int().positive(),
    securityScan: z.object({
      promptInjection: z.boolean(),
      credential: z.boolean(),
      sshBackdoor: z.boolean(),
      invisibleUnicode: z.boolean()
    })
  }),
  tasks: z.object({
    longRunningThresholds: z.object({
      runningSeconds: z.number().int().nonnegative(),
      toolCallCount: z.number().int().nonnegative(),
      subagentCount: z.number().int().nonnegative()
    }),
    scheduler: z.object({
      catchUpOnStartup: z.boolean(),
      maxRegisteredTasks: z.number().int().positive()
    })
  })
});

export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsToolCalls: z.boolean()
});

export const ProviderCredentialRefSchema = z
  .string()
  .nullable()
  .refine(
    (value) => value === null || PROVIDER_CREDENTIAL_REF_PATTERN.test(value),
    'Provider 凭据引用必须为 secret:<providerId> 或 null。'
  );

const NvidiaToolChoiceSchema = z.union([
  z.literal('auto'),
  z.literal('required'),
  z.literal('none'),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1)
    })
  })
]);

const SamplingProfileOverridesSchema = z.object({
  temperature: z.number().finite().optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(-1).optional(),
  minP: z.number().min(0).max(1).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  repeatPenalty: z.number().min(0).max(2).optional()
});

export const ProviderOptionsSchema = z
  .object({
    temperature: z.number().finite().optional(),
    maxTokens: z.number().int().positive().optional(),
    thinking: z.boolean().optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().min(-1).optional(),
    minP: z.number().min(0).max(1).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    repetitionPenalty: z.number().min(0).max(2).optional(),
    seed: z.number().int().optional(),
    stop: z.array(z.string().min(1)).max(4).optional(),
    includeReasoning: z.boolean().optional(),
    parallelToolCalls: z.boolean().optional(),
    streamUsage: z.boolean().optional(),
    toolChoice: NvidiaToolChoiceSchema.optional(),
    guidedJson: z.record(z.string(), z.unknown()).optional(),
    guidedRegex: z.string().min(1).optional(),
    guidedChoice: z.array(z.string().min(1)).min(1).optional(),
    guidedGrammar: z.string().min(1).optional(),
    endpointOverride: z.string().url().optional(),
    contextBudgetTokens: z.number().int().positive().optional(),
    samplingProfileOverrides: SamplingProfileOverridesSchema.optional()
  })
  .optional();

export const ProviderSchema: z.ZodType<ProviderConfig> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['openai_compatible', 'anthropic_compatible', 'nvidia', 'llama_cpp', 'ollama', 'custom']),
  endpoint: z.string().min(1),
  credentialRef: ProviderCredentialRefSchema,
  enabled: z.boolean(),
  models: z.array(ProviderModelSchema),
  options: ProviderOptionsSchema
});

export const ProvidersSchema: z.ZodType<ProvidersConfig> = z.object({
  schemaVersion: z.literal(1),
  defaultModelId: z.string().nullable(),
  providers: z.array(ProviderSchema)
});

export const McpServerSchema: z.ZodType<McpServerConfig> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http', 'sse']),
  preset: z.boolean(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  url: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1))
});

export const McpServersConfigSchema: z.ZodType<McpServersConfig> = z.object({
  schemaVersion: z.literal(1),
  servers: z.array(McpServerSchema)
});

export const ApprovalModeSchema = z.enum(['fully_automatic', 'default']);

export const PermissionsConfigSchema: z.ZodType<PermissionsConfig> = z.object({
  schemaVersion: z.literal(3),
  mode: ApprovalModeSchema,
  grants: z.array(z.unknown())
});

export const ShortcutsConfigSchema: z.ZodType<ShortcutsConfig> = z.object({
  schemaVersion: z.literal(1),
  shortcuts: z.array(z.unknown())
});

export const SettingsSaveRequestSchema: z.ZodType<SettingsSaveRequest> = z.object({
  settings: SettingsSchema,
  providers: z.array(ProviderSchema),
  defaultModelId: z.string().nullable(),
  permissions: PermissionsConfigSchema
});

export const SettingsDocumentSchema: z.ZodType<RocSettingsDocument> = z.object({
  schemaVersion: z.literal(4),
  settings: SettingsSchema,
  providers: ProvidersSchema,
  mcp: McpServersConfigSchema,
  permissions: PermissionsConfigSchema,
  shortcuts: ShortcutsConfigSchema
});
