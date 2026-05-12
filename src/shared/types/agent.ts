import type { DefaultModelState } from './settings';

export type EnabledCapabilities = {
  mcpServers: string[];
  skills: string[];
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
