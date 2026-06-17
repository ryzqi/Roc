import type {
  AgentCapabilityCard,
  AgentCapabilityPreview,
  AgentInterruptPolicy,
  AgentRuntimeStatus,
  AgentSubagentPreview,
  ApprovalMode,
  DeepAgentConfigPreview,
  EnabledCapabilities,
  InterruptDecisionType,
  McpServerSnapshot,
  SkillSnapshot,
  SkippedCapability
} from '../../../shared/types';
import { DEEP_AGENT_BUILT_IN_TOOLS } from '../../services/deep-agent/types';

const deleteFileAllowedDecisions: ReadonlyArray<InterruptDecisionType> = ['approve', 'edit', 'reject'];
const mcpAllowedDecisions: ReadonlyArray<InterruptDecisionType> = ['approve', 'reject'];

export function buildAgentCapabilityPreview(input: {
  approvalMode: ApprovalMode;
  mcpServers: McpServerSnapshot[];
  requestedCapabilities: EnabledCapabilities;
  runtimeStatus: AgentRuntimeStatus;
  skills: SkillSnapshot[];
}): AgentCapabilityPreview {
  const defaultModelState = input.runtimeStatus.defaultModelState;
  if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null) {
    throw new Error('default_model_missing');
  }

  const skippedCapabilities: SkippedCapability[] = [];
  const selectedMcpServers: string[] = [];
  const selectedSkills: string[] = [];
  const selectedMcpCards: AgentCapabilityCard[] = [];
  const selectedSkillCards: AgentCapabilityCard[] = [];

  for (const serverId of input.requestedCapabilities.mcpServers) {
    const server = input.mcpServers.find((item) => item.id === serverId);
    if (server === undefined) {
      skippedCapabilities.push({ id: serverId, type: 'mcp_server', reason: 'not_found' });
      continue;
    }
    if (!server.enabled) {
      skippedCapabilities.push({ id: serverId, type: 'mcp_server', reason: 'disabled' });
      continue;
    }
    selectedMcpServers.push(server.id);
    selectedMcpCards.push(...createMcpToolCards(server, input.approvalMode));
  }

  for (const skillId of input.requestedCapabilities.skills) {
    const skill = input.skills.find((item) => item.id === skillId);
    if (skill === undefined) {
      skippedCapabilities.push({ id: skillId, type: 'skill', reason: 'not_found' });
      continue;
    }
    if (!skill.enabled) {
      skippedCapabilities.push({ id: skillId, type: 'skill', reason: 'disabled' });
      continue;
    }
    if (skill.status !== 'ready') {
      skippedCapabilities.push({ id: skillId, type: 'skill', reason: 'invalid' });
      continue;
    }
    selectedSkills.push(skill.id);
    selectedSkillCards.push(createSkillCard(skill));
  }

  const toolCards = [
    createRunShellCommandCard(),
    createWebReadCard(),
    createDeleteFileCard(input.approvalMode),
    ...selectedMcpCards
  ];

  return {
    runnable: false,
    modelId: defaultModelState.modelId,
    builtInTools: [...DEEP_AGENT_BUILT_IN_TOOLS],
    selectedCapabilities: {
      mcpServers: selectedMcpServers,
      skills: selectedSkills
    },
    requestedCapabilities: input.requestedCapabilities,
    skippedCapabilities,
    toolCards,
    skillCards: selectedSkillCards,
    subagents: createSubagents(),
    interruptOn: createInterruptPolicy(input.approvalMode, selectedMcpCards.map((card) => card.name)),
    untrustedContextPolicy: 'external_content_reference_only',
    reason: '当前仅生成本轮能力清单预览，实际运行时才会装配 Deep Agents。'
  };
}

export function buildDeepAgentConfigPreview(input: {
  approvalMode: ApprovalMode;
  runtimeStatus: AgentRuntimeStatus;
}): DeepAgentConfigPreview {
  const defaultModelState = input.runtimeStatus.defaultModelState;
  if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null) {
    throw new Error('default_model_missing');
  }

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
    interruptOn: createInterruptPolicy(input.approvalMode, []),
    reason: 'Roc 不在 preview 阶段实际装配 Deep Agents，本结果反映下一轮装配将使用的参数。'
  };
}

function createMcpToolCards(server: McpServerSnapshot, approvalMode: ApprovalMode): AgentCapabilityCard[] {
  const requiresApproval = approvalMode === 'default';
  const approvalHint =
    approvalMode === 'default'
      ? '当前全局策略会在 MCP 调用时弹出审批卡。'
      : '当前全局策略会直接执行 MCP 调用。';
  if (server.id === 'exa-hosted') {
    return [
      {
        id: 'mcp:exa-hosted:web_search',
        name: 'web_search',
        capabilityType: 'mcp_tool',
        description: '搜索公开网络信息，返回可继续阅读和核实的结果列表。',
        requiredInput: 'query',
        scope: 'external',
        dependencies: [server.id],
        sideEffects: ['external_tool_call'],
        requiresApproval,
        supportsLongTermGrant: true,
        revokeGrantHint: `${approvalHint} supportsLongTermGrant 仅表示可长期保留该能力授权。`,
        riskLevel: server.riskLevel === undefined ? 'medium' : server.riskLevel,
        auditCategory: 'mcp_call',
        untrustedContext: true
      }
    ];
  }
  if (server.allowedTools === undefined) {
    return [];
  }
  return server.allowedTools.map((toolName) => ({
    id: `mcp:${server.id}:${toolName}`,
    name: toolName,
    capabilityType: 'mcp_tool',
    description: `${server.name} 提供的 ${toolName} 调用入口。`,
    requiredInput: 'tool-specific structured input',
    scope: 'external',
    dependencies: [server.id],
    sideEffects: ['external_tool_call'],
    requiresApproval,
    supportsLongTermGrant: true,
    revokeGrantHint: `${approvalHint} supportsLongTermGrant 仅表示可长期保留该能力授权。`,
    riskLevel: server.riskLevel === undefined ? 'medium' : server.riskLevel,
    auditCategory: 'mcp_call',
    untrustedContext: true
  }));
}

function createSkillCard(skill: SkillSnapshot): AgentCapabilityCard {
  return {
    id: `skill:${skill.id}`,
    name: skill.name,
    capabilityType: 'skill',
    description: skill.description,
    requiredInput: 'task goal and selected context',
    scope: 'app',
    dependencies: [],
    sideEffects: ['can_trigger_tools_through_agent'],
    requiresApproval: false,
    supportsLongTermGrant: true,
    revokeGrantHint: '在能力管理视图禁用或撤销该 Skill 授权。',
    riskLevel: 'low',
    auditCategory: 'skill_loaded',
    untrustedContext: false,
    sourcePath: skill.path
  };
}

function createWebReadCard(): AgentCapabilityCard {
  return {
    id: 'web:web_read',
    name: 'web_read',
    capabilityType: 'web_read',
    description: '读取指定 URL 的网页正文，返回可继续分析的文本内容。',
    requiredInput: 'url',
    scope: 'network',
    dependencies: ['explicit_url'],
    sideEffects: ['network_read'],
    requiresApproval: false,
    supportsLongTermGrant: true,
    revokeGrantHint: '在设置页网页与搜索授权中撤销。',
    riskLevel: 'medium',
    auditCategory: 'web_read',
    untrustedContext: true
  };
}

function createRunShellCommandCard(): AgentCapabilityCard {
  return {
    id: 'builtin:run_shell_command',
    name: 'run_shell_command',
    capabilityType: 'terminal_tool',
    description: '通过 Roc Windows 命令工具在当前工作区执行 PowerShell 命令，由 Roc 的 RTK 与审计层统一包裹。',
    requiredInput: 'PowerShell command',
    scope: 'workspace',
    dependencies: ['ShellExecutionService', 'RtkService'],
    sideEffects: ['workspace_command_execution', 'task_trace_audit'],
    requiresApproval: false,
    supportsLongTermGrant: false,
    revokeGrantHint: 'run_shell_command 由 Roc 内置工具提供，不创建长期授权。',
    riskLevel: 'medium',
    auditCategory: 'agent_execute',
    untrustedContext: false
  };
}

function createDeleteFileCard(approvalMode: ApprovalMode): AgentCapabilityCard {
  return {
    id: 'builtin:delete_file',
    name: 'delete_file',
    capabilityType: 'terminal_tool',
    description: '删除当前工作区内的文件或空目录，并在删除前写入恢复点。',
    requiredInput: 'workspace relative path',
    scope: 'workspace',
    dependencies: ['FileService'],
    sideEffects: ['workspace_delete', 'recovery_point_write'],
    requiresApproval: approvalMode === 'default',
    supportsLongTermGrant: false,
    revokeGrantHint: 'delete_file 由 Roc 内置文件服务提供，不创建长期授权。',
    riskLevel: 'high',
    auditCategory: 'workspace_delete',
    untrustedContext: false
  };
}

function createSubagents(): AgentSubagentPreview[] {
  return [
    {
      id: 'code-review',
      name: '代码审查子任务',
      purpose: '隔离审查上下文，并把 bug、风险与缺失验证回流主任务轨迹。',
      skills: [],
      tools: []
    },
    {
      id: 'research',
      name: '资料检索子任务',
      purpose: '围绕网页阅读整理外部资料结论，并明确来源边界。',
      skills: [],
      tools: ['web_read']
    }
  ];
}

function createInterruptPolicy(approvalMode: ApprovalMode, mcpToolNames: string[]): AgentInterruptPolicy {
  const policy: AgentInterruptPolicy = {};
  if (approvalMode === 'fully_automatic') {
    return policy;
  }
  policy.delete_file = {
    allowedDecisions: [...deleteFileAllowedDecisions]
  };
  for (const toolName of mcpToolNames) {
    policy[toolName] = {
      allowedDecisions: [...mcpAllowedDecisions]
    };
  }
  return policy;
}
