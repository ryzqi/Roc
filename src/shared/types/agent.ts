import type { DefaultModelState } from './settings';

export type EnabledCapabilities = {
  mcpServers: string[];
  skills: string[];
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
  interruptOn: AgentInterruptPolicy;
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
