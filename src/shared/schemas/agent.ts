import { z } from 'zod';

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
    modelVisibleName: z.string(),
    provenance: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('builtin'), source: z.literal('roc') }).strict(),
      z.object({ kind: z.literal('mcp'), serverId: z.string() }).strict()
    ]),
    executionScopes: z.array(z.enum(['main', 'subagent'])),
    riskLevel: agentCapabilityRiskSchema,
    effectClass: z.enum(['external_call', 'host_execution', 'network_read', 'none', 'workspace_mutation']),
    approvalPolicy: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
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
    description: z.string()
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

export const runBudgetV1Schema = z
  .object({
    contextBudgetTokens: z.number().int().positive().nullable()
  })
  .strict();

export const runBudgetV2Schema = z
  .object({
    contextBudgetTokens: z.number().int().positive().nullable(),
    modelCallLimit: z.number().int().positive(),
    modelThreadCallLimit: z.number().int().positive(),
    toolCallLimit: z.number().int().positive(),
    toolThreadCallLimit: z.number().int().positive()
  })
  .strict();

const runExecutionSnapshotShape = {
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
  dispatchKey: identifierSchema.nullable()
} as const;

export const runExecutionSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ...runExecutionSnapshotShape,
    budget: runBudgetV1Schema
  })
  .strict();

export const runExecutionSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...runExecutionSnapshotShape,
    budget: runBudgetV2Schema,
    shellAllowedCommands: z.array(identifierSchema).optional()
  })
  .strict();

export const runExecutionSnapshotSchema = z.discriminatedUnion('schemaVersion', [
  runExecutionSnapshotV1Schema,
  runExecutionSnapshotV2Schema
]);

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
export type RunCapabilityProvenanceV1 = z.infer<typeof runCapabilityManifestToolSchema>['provenance'];
export type RunCapabilityEffectClassV1 = z.infer<typeof runCapabilityManifestToolSchema>['effectClass'];
export type RunCapabilityApprovalPolicyV1 = z.infer<typeof runCapabilityManifestToolSchema>['approvalPolicy'];
export type RunCapabilityReconcileStrategyV1 = NonNullable<z.infer<typeof runCapabilityManifestToolSchema>['reconcileStrategy']>;
export type RunCapabilityManifestToolV1 = z.infer<typeof runCapabilityManifestToolSchema>;
export type RunCapabilityManifestSkillV1 = z.infer<typeof runCapabilityManifestSkillSchema>;
export type RunCapabilityManifestV1 = z.infer<typeof runCapabilityManifestSchema>;
export type RunBudgetV1 = z.infer<typeof runBudgetV1Schema>;
export type RunBudgetV2 = z.infer<typeof runBudgetV2Schema>;
export type RunExecutionMode = z.infer<typeof runExecutionModeSchema>;
export type RunExecutionSnapshotV1 = z.infer<typeof runExecutionSnapshotV1Schema>;
export type RunExecutionSnapshotV2 = z.infer<typeof runExecutionSnapshotV2Schema>;
export type AgentRuntimeStatus = z.infer<typeof agentRuntimeStatusSchema>;
