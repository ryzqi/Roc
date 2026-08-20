import { z } from 'zod';

import {
  sessionListInputSchema,
  sessionMessageSchema,
  sessionMessageSearchRequestSchema,
  sessionMessageSearchResultSchema
} from './agent';
import {
  approvalModeSchema,
  mcpServersConfigSchema,
  mcpServerSnapshotSchema,
  skillSnapshotSchema
} from './ipc-mcp-skills';
import { hookRunSummarySchema } from './task-event';

const jsonObjectSchema = z.record(z.string(), z.json());

export const memoryScopeSchema = z.enum(['global', 'workspace']);
export const memoryKindSchema = z.enum(['user', 'agents', 'memory']);

export const memoryFileReadRequestSchema = z
  .object({ scope: memoryScopeSchema, kind: memoryKindSchema })
  .strict();

const memoryFileMetaSchema = z
  .object({
    scope: memoryScopeSchema,
    kind: memoryKindSchema,
    exists: z.boolean(),
    charCount: z.number().int(),
    charLimit: z.number().int(),
    absolutePath: z.string(),
    effective: z.boolean(),
    updatedAt: z.string().nullable()
  })
  .strict();

const autoMemoryAuditRecordSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    action: z.enum([
      'accepted',
      'rejected',
      'duplicate_skipped',
      'conflict_rejected',
      'maintenance_merged',
      'maintenance_deleted',
      'write_failed'
    ]),
    type: z.enum([
      'user_preference',
      'workspace_fact',
      'decision',
      'pitfall',
      'verification',
      'transient_task_result'
    ]),
    scope: memoryScopeSchema,
    confidence: z.enum(['high', 'medium', 'low']),
    key: z.string(),
    summary: z.string(),
    sourceRunId: z.string(),
    reason: z.string(),
    workspacePath: z.string().nullable(),
    targetPath: z.string().nullable()
  })
  .strict();

const securityScanIssueSchema = z
  .object({
    category: z.enum(['prompt_injection', 'credential', 'ssh_backdoor', 'invisible_unicode']),
    pattern: z.string(),
    matchExcerpt: z.string()
  })
  .strict();

export const memoryFileWriteRequestSchema = z
  .object({ scope: memoryScopeSchema, kind: memoryKindSchema, content: z.string() })
  .strict();

export const memoryFileWriteOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), meta: memoryFileMetaSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(['security_scan', 'capacity_exceeded', 'invalid_path', 'workspace_required']),
      detail: z.string(),
      chars: z.number().int().optional(),
      limit: z.number().int().optional(),
      issues: z.array(securityScanIssueSchema).optional()
    })
    .strict()
]);

export const memoryStatusSchema = z
  .object({
    root: z.string(),
    workspaceHash: z.string().nullable(),
    workspaceLabel: z.string().nullable(),
    files: z.array(memoryFileMetaSchema),
    snapshot: z
      .object({ enabled: z.boolean(), totalChars: z.number().int(), totalLimit: z.number().int() })
      .strict(),
    sessionMessages: z
      .object({
        totalRows: z.number().int(),
        retentionDays: z.number().int(),
        oldestAt: z.string().nullable()
      })
      .strict(),
    fullTextIndex: z.object({ healthy: z.boolean(), status: z.literal('ready') }).strict(),
    autoMemory: z
      .object({
        enabled: z.boolean(),
        auditRetentionDays: z.number().int(),
        recent: z.array(autoMemoryAuditRecordSchema)
      })
      .strict()
  })
  .strict();

export const memorySnapshotPreviewSchema = z.object({ text: z.string() }).strict();

export const rocHookEventNameSchema = z.enum([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd'
]);

const rocHookCommandHandlerSchema = z
  .object({
    type: z.literal('command'),
    command: z.string().trim().min(1),
    commandWindows: z.string().trim().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).max(600).default(30),
    statusMessage: z.string().trim().min(1).optional(),
    enabled: z.boolean().default(true),
    failureMode: z.enum(['continue', 'block']).default('continue')
  })
  .strict();

const rocHookMatcherGroupSchema = z
  .object({
    matcher: z.string().optional(),
    hooks: z.array(rocHookCommandHandlerSchema).min(1)
  })
  .strict();

const rocHooksRecordSchema = z
  .object({
    SessionStart: z.array(rocHookMatcherGroupSchema).optional(),
    UserPromptSubmit: z.array(rocHookMatcherGroupSchema).optional(),
    PreToolUse: z.array(rocHookMatcherGroupSchema).optional(),
    PostToolUse: z.array(rocHookMatcherGroupSchema).optional(),
    Stop: z.array(rocHookMatcherGroupSchema).optional(),
    SessionEnd: z.array(rocHookMatcherGroupSchema).optional()
  })
  .strict();

export const rocHookConfigSchema = z
  .object({ schemaVersion: z.literal(1), hooks: rocHooksRecordSchema })
  .strict();

const rocHookConfiguredHandlerSnapshotSchema = z
  .object({
    id: z.string(),
    event: rocHookEventNameSchema,
    matcher: z.string().nullable(),
    command: z.string(),
    commandWindows: z.string().nullable(),
    timeoutSeconds: z.number(),
    statusMessage: z.string().nullable(),
    enabled: z.boolean(),
    failureMode: z.enum(['continue', 'block']),
    hash: z.string(),
    trustState: z.enum(['trusted', 'review_required', 'disabled', 'invalid']),
    validationError: z.string().nullable(),
    lastRun: hookRunSummarySchema.nullable()
  })
  .strict();

export const rocHookConfigSnapshotSchema = z
  .object({
    configPath: z.string(),
    exists: z.boolean(),
    config: rocHookConfigSchema,
    handlers: z.array(rocHookConfiguredHandlerSnapshotSchema),
    validationErrors: z.array(z.string())
  })
  .strict();

export const settingsSaveHookConfigRequestSchema = z
  .object({ config: rocHookConfigSchema })
  .strict();

export const settingsTrustHookRequestSchema = z
  .object({ handlerId: z.string().trim().min(1), hash: z.string().trim().min(1) })
  .strict();

export const appSettingsSchema = z
  .object({
    schemaVersion: z.literal(2),
    defaultWorkspace: z.string().nullable(),
    startup: z.object({ openAtLogin: z.boolean(), minimizeToTray: z.boolean() }).strict(),
    globalHotkey: z.string().nullable(),
    memory: z
      .object({
        charLimits: z
          .object({
            user: z.number().int().positive(),
            agents: z.number().int().positive(),
            memory: z.number().int().positive()
          })
          .strict(),
        sessionRetentionDays: z.number().int().positive(),
        securityScan: z
          .object({
            promptInjection: z.boolean(),
            credential: z.boolean(),
            sshBackdoor: z.boolean(),
            invisibleUnicode: z.boolean()
          })
          .strict(),
        autoMemory: z
          .object({
            enabled: z.boolean(),
            lowConfidenceTtlDays: z.number().int().positive(),
            auditRetentionDays: z.number().int().positive(),
            maxCandidatesPerRun: z.number().int().positive()
          })
          .strict()
      })
      .strict(),
    tasks: z
      .object({
        longRunningThresholds: z
          .object({
            runningSeconds: z.number().int().nonnegative(),
            toolCallCount: z.number().int().nonnegative(),
            subagentCount: z.number().int().nonnegative()
          })
          .strict(),
        scheduler: z
          .object({ catchUpOnStartup: z.boolean(), maxRegisteredTasks: z.number().int().positive() })
          .strict()
      })
      .strict()
  })
  .strict();

export const providerModelSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    enabled: z.boolean(),
    supportsStreaming: z.boolean(),
    supportsToolCalls: z.boolean(),
    supportsImages: z.boolean(),
    options: z
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
        useResponsesApi: z.boolean().optional(),
        reasoning: z
          .object({
            effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
            summary: z.enum(['auto', 'concise', 'detailed']).optional()
          })
          .strict()
          .optional(),
        includeReasoning: z.boolean().optional(),
        parallelToolCalls: z.boolean().optional(),
        streamUsage: z.boolean().optional(),
        serviceTier: z.enum(['auto', 'default', 'flex', 'scale', 'priority']).optional(),
        verbosity: z.enum(['low', 'medium', 'high']).optional(),
        zdrEnabled: z.boolean().optional(),
        modelKwargs: jsonObjectSchema.optional(),
        anthropicThinking: z
          .discriminatedUnion('mode', [
            z.object({ mode: z.literal('disabled') }).strict(),
            z.object({ mode: z.literal('adaptive') }).strict(),
            z.object({ mode: z.literal('enabled'), budgetTokens: z.number().int().min(1024) }).strict()
          ])
          .optional(),
        toolChoice: z
          .union([
            z.enum(['auto', 'required', 'none']),
            z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }).strict() }).strict()
          ])
          .optional(),
        guidedJson: jsonObjectSchema.optional(),
        guidedRegex: z.string().min(1).optional(),
        guidedChoice: z.array(z.string().min(1)).min(1).optional(),
        guidedGrammar: z.string().min(1).optional(),
        contextBudgetTokens: z.number().int().positive().optional(),
        samplingProfileOverrides: z
          .object({
            temperature: z.number().finite().optional(),
            topP: z.number().min(0).max(1).optional(),
            topK: z.number().int().min(-1).optional(),
            minP: z.number().min(0).max(1).optional(),
            presencePenalty: z.number().min(-2).max(2).optional(),
            repeatPenalty: z.number().min(0).max(2).optional()
          })
          .strict()
          .optional(),
        invocationKwargs: jsonObjectSchema.optional(),
        anthropicBetas: z.array(z.string()).optional()
      })
      .strict()
      .superRefine((options, context) => {
        if (options.reasoning !== undefined && options.reasoning.effort === undefined && options.reasoning.summary === undefined) {
          context.addIssue({ code: 'custom', path: ['reasoning'], message: 'reasoning requires effort or summary' });
        }
        if (
          options.anthropicThinking?.mode === 'enabled' &&
          options.maxTokens !== undefined &&
          options.anthropicThinking.budgetTokens >= options.maxTokens
        ) {
          context.addIssue({ code: 'custom', path: ['anthropicThinking', 'budgetTokens'], message: 'thinking budget must be less than max tokens' });
        }
      })
      .optional()
  })
  .strict();

export const providerModelOptionsSchema = providerModelSchema.shape.options.unwrap();

export const providerConnectionOptionsSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    defaultHeaders: z.record(z.string(), z.string()).optional(),
    organization: z.string().min(1).optional(),
    endpointOverride: z.string().url().optional()
  })
  .strict();

export const providerConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum([
      'openai_compatible',
      'anthropic_compatible',
      'nvidia',
      'openrouter',
      'llama_cpp',
      'ollama',
      'custom'
    ]),
    endpoint: z.string().min(1),
    credentialRef: z
      .string()
      .nullable()
      .refine(
        (value) => value === null || /^secret:[A-Za-z0-9_-]+$/u.test(value),
        'Provider 凭据引用必须为 secret:<providerId> 或 null。'
      ),
    enabled: z.boolean(),
    models: z.array(providerModelSchema),
    options: providerConnectionOptionsSchema.optional()
  })
  .strict()
  .superRefine((provider, context) => {
    const seenModelIds = new Set<string>();
    provider.models.forEach((model, index) => {
      if (seenModelIds.has(model.id)) {
        context.addIssue({
          code: 'custom',
          path: ['models', index, 'id'],
          message: `Provider model ID must be unique: ${model.id}`
        });
      }
      seenModelIds.add(model.id);
    });
  });

export const providerTestResultSchema = z
  .object({
    providerId: z.string(),
    status: z.enum(['ready', 'invalid']),
    defaultModelReady: z.boolean(),
    checked: z.array(z.string()),
    modelId: z.string().nullable().optional(),
    error: z.string().nullable(),
    latencyMs: z.number().nullable()
  })
  .strict();

export const providerTestRequestSchema = z
  .object({ providerId: z.string().trim().min(1), modelId: z.string().trim().min(1) })
  .strict();

export const providersConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    defaultModelId: z.string().nullable(),
    providers: z.array(providerConfigSchema)
  })
  .strict();

export const permissionsConfigSchema = z
  .object({ schemaVersion: z.literal(3), mode: approvalModeSchema, grants: z.array(z.json()) })
  .strict();

export const shortcutsConfigSchema = z
  .object({ schemaVersion: z.literal(1), shortcuts: z.array(z.json()) })
  .strict();

export const settingsSaveRequestSchema = z
  .object({
    settings: appSettingsSchema,
    providers: z.array(providerConfigSchema),
    defaultModelId: z.string().nullable(),
    permissions: permissionsConfigSchema
  })
  .strict();

export const providerSecretSetRequestSchema = z
  .object({ providerId: z.string(), plaintext: z.string() })
  .strict();

export const hostIntegrationStatusSchema = z
  .object({
    startup: z
      .object({
        configuredOpenAtLogin: z.boolean(),
        effectiveOpenAtLogin: z.boolean(),
        syncError: z.string().nullable()
      })
      .strict(),
    globalHotkey: z
      .object({
        accelerator: z.string().nullable(),
        registered: z.boolean(),
        registrationError: z.string().nullable()
      })
      .strict()
  })
  .strict();

export const providerSecretStatusSchema = z
  .object({ providerId: z.string(), stored: z.boolean() })
  .strict();

export const settingsSnapshotSchema = z
  .object({
    settings: appSettingsSchema,
    providers: z.array(providerConfigSchema),
    defaultModelId: z.string().nullable(),
    providerSecretStatus: z.array(providerSecretStatusSchema),
    permissions: permissionsConfigSchema,
    mcpServers: z.array(mcpServerSnapshotSchema),
    skills: z.array(skillSnapshotSchema),
    hooks: rocHookConfigSnapshotSchema,
    hostIntegration: hostIntegrationStatusSchema
  })
  .strict();

export const providerSecretSetResultSchema = z
  .object({ providerId: z.string(), stored: z.literal(true) })
  .strict();

export const providerSecretClearResultSchema = z
  .object({ providerId: z.string(), stored: z.literal(false) })
  .strict();

export const settingsDocumentSchema = z
  .object({
    schemaVersion: z.literal(4),
    settings: appSettingsSchema,
    providers: providersConfigSchema,
    mcp: mcpServersConfigSchema,
    permissions: permissionsConfigSchema,
    shortcuts: shortcutsConfigSchema
  })
  .strict();

export {
  sessionListInputSchema,
  sessionMessageSchema,
  sessionMessageSearchRequestSchema,
  sessionMessageSearchResultSchema
};
