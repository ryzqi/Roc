import { z } from 'zod';
import { taskContractSchema } from './task-acceptance';
import { frozenExecutionInputsSchema, executionNodeBindingSchema, executionOriginSchema } from './execution';

import { mcpServerConfigSchema, mcpToolContractSchema } from './ipc-mcp-skills';
import { hitlDecisionTypeSchema } from './hitl';

const identifierSchema = z.string().trim().min(1);
const agentCapabilityTypeSchema = z.enum(['mcp_tool', 'terminal_tool', 'web_read', 'skill', 'subagent']);
const agentCapabilityScopeSchema = z.enum(['app', 'workspace', 'memory', 'network', 'external']);
const agentCapabilityRiskSchema = z.enum(['none', 'low', 'medium', 'high', 'critical']);
const runOriginSchema = z.enum(['background_schedule', 'chat', 'manual_task_run', 'workbench_creation']);

export const workflowHintSchema = z.enum([
  'propose_background_task',
  'background_task_change'
]).nullable();

export const enabledCapabilitiesSchema = z
  .object({
    mcpServers: z.array(identifierSchema),
    skills: z.array(identifierSchema)
  })
  .strict();

export const agentCapabilityPreviewRequestSchema = enabledCapabilitiesSchema.extend({
  mode: z.enum(['chat', 'plan', 'task'])
});

export const agentInterruptPolicyValueSchema = z.union([
  z.literal(true),
  z
    .object({
      allowedDecisions: z.array(hitlDecisionTypeSchema)
    })
    .strict()
]);

export const agentInterruptPolicySchema = z.record(z.string(), agentInterruptPolicyValueSchema);

export const agentCapabilityCardSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    capabilityType: agentCapabilityTypeSchema,
    description: z.string(),
    requiredInput: z.string(),
    scope: agentCapabilityScopeSchema,
    dependencies: z.array(z.string()),
    sideEffects: z.array(z.string()),
    requiresApproval: z.boolean(),
    supportsLongTermGrant: z.boolean(),
    revokeGrantHint: z.string(),
    riskLevel: agentCapabilityRiskSchema,
    auditCategory: z.string(),
    untrustedContext: z.boolean(),
    sourcePath: z.string().optional()
  })
  .strict();

export const skippedCapabilitySchema = z
  .object({
    id: z.string(),
    type: z.enum(['mcp_server', 'skill']),
    reason: z.enum(['not_found', 'disabled', 'invalid'])
  })
  .strict();

export const agentSubagentPreviewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    purpose: z.string(),
    skills: z.array(z.string()),
    tools: z.array(z.string())
  })
  .strict();

export const runCapabilityManifestToolSchema = z
  .object({
    canonicalIdentity: z.string(),
    toolVersion: z.string().trim().min(1).optional(),
    mcpContract: mcpToolContractSchema.optional(),
    modelVisibleName: z.string(),
    provenance: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('builtin'), source: z.literal('roc') }).strict(),
      z.object({ kind: z.literal('mcp'), serverId: z.string() }).strict()
    ]),
    executionScopes: z.array(z.enum(['main', 'subagent'])),
    riskLevel: agentCapabilityRiskSchema,
    effectClass: z.enum(['external_call', 'host_execution', 'isolated_execution', 'network_read', 'none', 'workspace_mutation']),
    approvalPolicy: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
      z.object({ kind: z.literal('native_dialog') }).strict(),
      z
        .object({
          kind: z.literal('required'),
          allowedDecisions: z.array(hitlDecisionTypeSchema)
        })
        .strict()
    ]),
    idempotencyStrategy: z.enum(['none', 'tool_call']),
    reconcileStrategy: z.enum(['none', 'retry_safe', 'manual_confirmation']).optional(),
    resourceScope: agentCapabilityScopeSchema
  })
  .strict();

export const runCapabilityManifestSkillSchema = z
  .object({
    canonicalIdentity: z.string(),
    name: z.string(),
    sourcePath: z.string(),
    description: z.string(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    license: z.string().nullable(),
    licenseHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    sourceRevision: z.string().nullable()
  })
  .strict();

export const runCapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestedCapabilities: enabledCapabilitiesSchema,
    resolvedCapabilities: enabledCapabilitiesSchema,
    skippedCapabilities: z.array(skippedCapabilitySchema),
    tools: z.array(runCapabilityManifestToolSchema),
    skills: z.array(runCapabilityManifestSkillSchema),
    mcpServers: z.array(mcpServerConfigSchema),
    untrustedContextPolicy: z.literal('external_content_reference_only')
  })
  .strict();

export const agentCapabilityPreviewSchema = z
  .object({
    runnable: z.literal(false),
    modelId: z.string(),
    builtInTools: z.array(z.string()),
    toolCards: z.array(agentCapabilityCardSchema),
    skillCards: z.array(agentCapabilityCardSchema),
    subagents: z.array(agentSubagentPreviewSchema),
    interruptOn: agentInterruptPolicySchema,
    manifest: runCapabilityManifestSchema,
    reason: z.string()
  })
  .strict();

export const deepAgentConfigPreviewSchema = z
  .object({
    runnable: z.literal(false),
    model: z.string(),
    memoryAccess: z.literal('store_backend'),
    builtInTools: z.array(z.string()),
    rocTools: z.array(z.string()),
    todoMapping: z
      .object({
        sourceTool: z.literal('write_todos'),
        target: z.literal('task_steps')
      })
      .strict(),
    interruptOn: agentInterruptPolicySchema,
    reason: z.string()
  })
  .strict();

export const runExecutionModeSchema = z.enum(['plan', 'run', 'task']);

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const runModelConfigSchema = z.object({
  policyVersion: z.literal(1),
  contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict();

export const runUsageStatusSchema = z
  .object({
    tokens: z.object({
      settled: safeInteger,
      unknown: safeInteger,
      reserved: safeInteger
    }).strict(),
    calls: z.object({
      models: z.object({ total: safeInteger, reserved: safeInteger }).strict(),
      tools: z.object({ total: safeInteger, reserved: safeInteger }).strict(),
      children: z.object({ total: safeInteger, reserved: safeInteger }).strict()
    }).strict(),
  })
  .strict();

const runExecutionSnapshotShape = {
  submissionHash: identifierSchema,
  taskContract: taskContractSchema,
  runId: identifierSchema,
  threadId: identifierSchema,
  runOrigin: runOriginSchema,
  model: z
    .object({
      providerId: identifierSchema,
      modelId: identifierSchema
    })
    .strict(),
  mode: runExecutionModeSchema,
  workspace: z
    .object({
      path: identifierSchema,
      hash: identifierSchema
    })
    .strict()
    .nullable(),
  capabilityManifest: runCapabilityManifestSchema,
  workflowHint: workflowHintSchema,
  explicitSkillIds: z.array(z.string()),
  inputMessageId: identifierSchema,
  dispatchKey: identifierSchema.nullable(),
  researchProjectId: identifierSchema.nullable()
} as const;

export const workspaceFileIdentitySchema = z
  .object({
    path: identifierSchema,
    dev: z.string().min(1).max(128),
    ino: z.string().min(1).max(128)
  })
  .strict();

export const runExecutionSnapshotSchema = z.object({
  schemaVersion: z.literal(11),
  ...runExecutionSnapshotShape,
  nodeBinding: executionNodeBindingSchema,
  origin: executionOriginSchema,
  frozenInputs: frozenExecutionInputsSchema,
  workspaceIdentity: workspaceFileIdentitySchema.nullable(),
  modelConfig: runModelConfigSchema,
  shellAllowedCommands: z.array(identifierSchema).optional()
}).strict();

export const defaultModelStateSchema = z
  .object({
    status: z.enum(['missing', 'invalid', 'ready']),
    modelId: z.string().nullable(),
    providerId: z.string().nullable(),
    reason: z.string()
  })
  .strict();

export const agentRuntimeStatusSchema = z
  .object({
    deepAgentsPackage: z.enum(['available', 'missing']),
    deepAgentsApi: z.object({ createDeepAgent: z.boolean() }).strict(),
    defaultModelConfigured: z.boolean(),
    defaultModelState: defaultModelStateSchema,
    memoryAccess: z.literal('store_backend'),
    execution: z.enum(['blocked_until_provider_configured', 'ready'])
  })
  .strict();

export const sessionListInputSchema = z
  .object({
    threadId: z.string(),
    limit: z.number().int().positive().optional()
  })
  .strict();

export const sessionMessageSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    threadTitle: z.string().nullable(),
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string(),
    phase: z.enum(['visible', 'pre_compaction_flush']),
    tokenCount: z.number().int().nullable(),
    workspaceHash: z.string().nullable(),
    createdAt: z.string()
  })
  .strict();

export const sessionMessageSearchRequestSchema = z
  .object({
    query: z.string(),
    workspaceScope: z.enum(['current', 'all']),
    workspaceHash: z.string().nullable().optional(),
    threadId: z.string().optional(),
    sinceDays: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional()
  })
  .strict();

export const sessionMessageSearchResultSchema = z
  .object({
    query: z.string(),
    total: z.number().int(),
    items: z.array(sessionMessageSchema.extend({ snippet: z.string() }))
  })
  .strict();

export type EnabledCapabilities = z.infer<typeof enabledCapabilitiesSchema>;
export type AgentCapabilityPreviewRequest = z.infer<typeof agentCapabilityPreviewRequestSchema>;
export type InterruptDecisionType = z.infer<typeof hitlDecisionTypeSchema>;
export type AgentInterruptPolicyValue = z.infer<typeof agentInterruptPolicyValueSchema>;
export type AgentInterruptPolicy = z.infer<typeof agentInterruptPolicySchema>;
export type DeepAgentConfigPreview = z.infer<typeof deepAgentConfigPreviewSchema>;
export type AgentCapabilityType = z.infer<typeof agentCapabilityTypeSchema>;
export type AgentCapabilityScope = z.infer<typeof agentCapabilityScopeSchema>;
export type AgentCapabilityRisk = z.infer<typeof agentCapabilityRiskSchema>;
export type AgentCapabilityCard = z.infer<typeof agentCapabilityCardSchema>;
export type SkippedCapability = z.infer<typeof skippedCapabilitySchema>;
export type AgentSubagentPreview = z.infer<typeof agentSubagentPreviewSchema>;
export type AgentCapabilityPreview = z.infer<typeof agentCapabilityPreviewSchema>;
export type RunCapabilityExecutionScopeV1 = z.infer<typeof runCapabilityManifestToolSchema>['executionScopes'][number];
export type McpToolContractV1 = z.infer<typeof mcpToolContractSchema>;
export type RunCapabilityProvenanceV1 = z.infer<typeof runCapabilityManifestToolSchema>['provenance'];
export type RunCapabilityEffectClassV1 = z.infer<typeof runCapabilityManifestToolSchema>['effectClass'];
export type RunCapabilityApprovalPolicyV1 = z.infer<typeof runCapabilityManifestToolSchema>['approvalPolicy'];
export type RunCapabilityReconcileStrategyV1 = NonNullable<z.infer<typeof runCapabilityManifestToolSchema>['reconcileStrategy']>;
export type RunCapabilityManifestToolV1 = z.infer<typeof runCapabilityManifestToolSchema>;
export type RunCapabilityManifestSkillV1 = z.infer<typeof runCapabilityManifestSkillSchema>;
export type RunCapabilityManifestV1 = z.infer<typeof runCapabilityManifestSchema>;
export type RunModelConfig = z.infer<typeof runModelConfigSchema>;
export type RunUsageStatus = z.infer<typeof runUsageStatusSchema>;
export type RunExecutionMode = z.infer<typeof runExecutionModeSchema>;
export type RunExecutionSnapshot = z.infer<typeof runExecutionSnapshotSchema>;
export type AgentRuntimeStatus = z.infer<typeof agentRuntimeStatusSchema>;
