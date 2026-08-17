import type { WorkflowHint } from './chat';
import type { DefaultModelState } from './settings';

export type EnabledCapabilities = {
  mcpServers: string[];
  skills: string[];
};

export type AgentCapabilityPreviewRequest = EnabledCapabilities & {
  mode: 'chat' | 'plan' | 'task';
};

export type InterruptDecisionType = 'approve' | 'edit' | 'reject';

export type AgentInterruptPolicyValue =
  | true
  | {
      allowedDecisions: InterruptDecisionType[];
    };

export type AgentInterruptPolicy = Record<string, AgentInterruptPolicyValue>;

export type DeepAgentConfigPreview = {
  runnable: false;
  model: string;
  memoryAccess: 'store_backend';
  builtInTools: string[];
  rocTools: string[];
  todoMapping: {
    sourceTool: 'write_todos';
    target: 'task_steps';
  };
  interruptOn: AgentInterruptPolicy;
  reason: string;
};

export type AgentCapabilityType = 'mcp_tool' | 'terminal_tool' | 'web_read' | 'skill' | 'subagent';
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
  skills: string[];
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
  interruptOn: AgentInterruptPolicy;
  manifest: RunCapabilityManifestV1;
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

export type RunCapabilityExecutionScopeV1 = 'main' | 'subagent';

export type RunCapabilityProvenanceV1 =
  | { kind: 'builtin'; source: 'roc' }
  | { kind: 'mcp'; serverId: string };

export type RunCapabilityEffectClassV1 =
  | 'external_call'
  | 'host_execution'
  | 'network_read'
  | 'none'
  | 'workspace_mutation';

export type RunCapabilityApprovalPolicyV1 =
  | { kind: 'none' }
  | { kind: 'required'; allowedDecisions: InterruptDecisionType[] };

export type RunCapabilityReconcileStrategyV1 = 'none' | 'retry_safe' | 'manual_confirmation';

export type RunCapabilityManifestToolV1 = {
  canonicalIdentity: string;
  modelVisibleName: string;
  provenance: RunCapabilityProvenanceV1;
  executionScopes: RunCapabilityExecutionScopeV1[];
  riskLevel: AgentCapabilityRisk;
  effectClass: RunCapabilityEffectClassV1;
  approvalPolicy: RunCapabilityApprovalPolicyV1;
  idempotencyStrategy: 'none' | 'tool_call';
  reconcileStrategy?: RunCapabilityReconcileStrategyV1;
  resourceScope: AgentCapabilityScope;
};

export type RunCapabilityManifestSkillV1 = {
  canonicalIdentity: string;
  name: string;
  sourcePath: string;
  description: string;
};

export type RunCapabilityManifestV1 = {
  schemaVersion: 1;
  manifestHash: string;
  requestedCapabilities: EnabledCapabilities;
  resolvedCapabilities: EnabledCapabilities;
  skippedCapabilities: SkippedCapability[];
  tools: RunCapabilityManifestToolV1[];
  skills: RunCapabilityManifestSkillV1[];
  untrustedContextPolicy: 'external_content_reference_only';
};

export type RunBudgetV1 = {
  contextBudgetTokens: number | null;
};

export type RunBudgetV2 = {
  contextBudgetTokens: number | null;
  modelCallLimit: number;
  modelThreadCallLimit: number;
  toolCallLimit: number;
  toolThreadCallLimit: number;
};

export type RunExecutionMode = 'plan' | 'run' | 'task';

type RunExecutionSnapshotFields = {
  runId: string;
  threadId: string;
  runOrigin: 'background_schedule' | 'chat' | 'manual_task_run' | 'workbench_creation';
  model: {
    providerId: string;
    modelId: string;
  };
  mode: RunExecutionMode;
  workspace: {
    path: string;
    hash: string;
  } | null;
  capabilityManifest: RunCapabilityManifestV1;
  workflowHint: WorkflowHint;
  explicitSkillIds: string[];
  inputMessageId: string;
  dispatchKey: string | null;
};

export type RunExecutionSnapshotV1 = RunExecutionSnapshotFields & {
  schemaVersion: 1;
  budget: RunBudgetV1;
};

export type RunExecutionSnapshotV2 = RunExecutionSnapshotFields & {
  schemaVersion: 2;
  budget: RunBudgetV2;
  shellAllowedCommands?: string[];
};

export type AgentRuntimeStatus = {
  deepAgentsPackage: 'available' | 'missing';
  deepAgentsApi: {
    createDeepAgent: boolean;
  };
  defaultModelConfigured: boolean;
  defaultModelState: DefaultModelState;
  memoryAccess: 'store_backend';
  execution: 'blocked_until_provider_configured' | 'ready';
};

export type AgentLangSmithConfigV1 = {
  schemaVersion: 1;
  enabled: boolean;
  projectName: string;
};

export type AgentLangSmithSettings = {
  config: AgentLangSmithConfigV1;
  apiKeyStored: boolean;
};

export type AgentLangSmithSetApiKeyRequest = {
  apiKey: string;
};
