import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  ApprovalMode,
  DeepAgentConfigPreview,
  EnabledCapabilities,
  McpServerSnapshot,
  SkillSnapshot,
  ChatRunMode,
  WorkflowHint
} from '../../../shared/types';
import { DEEP_AGENT_BUILT_IN_TOOLS } from '../../services/deep-agent/types';
import { compileRunCapabilityManifest } from './run-capability-manifest';

export function buildAgentCapabilityPreview(input: {
  deleteFileApprovalMode: ApprovalMode;
  explicitSkillIds?: readonly string[];
  mcpApprovalMode: ApprovalMode;
  mcpServers: McpServerSnapshot[];
  requestedCapabilities: EnabledCapabilities;
  shellAllowedCommands?: readonly string[];
  runtimeStatus: AgentRuntimeStatus;
  skills: SkillSnapshot[];
  mode: ChatRunMode;
  workflowHint: WorkflowHint;
}): AgentCapabilityPreview {
  const defaultModelState = input.runtimeStatus.defaultModelState;
  if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null) {
    throw new Error('default_model_missing');
  }
  const compiled = compileRunCapabilityManifest(input);

  return {
    runnable: false,
    modelId: defaultModelState.modelId,
    builtInTools: [...DEEP_AGENT_BUILT_IN_TOOLS],
    toolCards: compiled.toolCards,
    skillCards: compiled.skillCards,
    subagents: compiled.subagents,
    interruptOn: compiled.interruptOn,
    manifest: compiled.manifest,
    reason: '当前仅生成本轮能力清单预览，实际运行时才会装配 Deep Agents。'
  };
}

export function buildDeepAgentConfigPreview(input: {
  deleteFileApprovalMode: ApprovalMode;
  runtimeStatus: AgentRuntimeStatus;
  mode: ChatRunMode;
}): DeepAgentConfigPreview {
  const defaultModelState = input.runtimeStatus.defaultModelState;
  if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null) {
    throw new Error('default_model_missing');
  }
  const compiled = compileRunCapabilityManifest({
    deleteFileApprovalMode: input.deleteFileApprovalMode,
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    mode: input.mode,
    workflowHint: null,
    requestedCapabilities: {
      mcpServers: [],
      skills: []
    },
    skills: []
  });

  return {
    runnable: false,
    model: defaultModelState.modelId,
    memoryAccess: 'store_backend',
    builtInTools: [...DEEP_AGENT_BUILT_IN_TOOLS],
    rocTools: [],
    todoMapping: {
      sourceTool: 'write_todos',
      target: 'task_steps'
    },
    interruptOn: compiled.interruptOn,
    reason: 'Roc 不在 config preview 阶段装配选中的 MCP 或 Skill；本结果仅反映默认内置工具参数。'
  };
}
