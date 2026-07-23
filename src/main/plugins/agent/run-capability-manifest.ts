import { createHash } from 'node:crypto';

import type {
  AgentCapabilityCard,
  AgentInterruptPolicy,
  AgentSubagentPreview,
  ApprovalMode,
  ChatRunMode,
  EnabledCapabilities,
  InterruptDecisionType,
  McpServerSnapshot,
  RunCapabilityApprovalPolicyV1,
  RunCapabilityEffectClassV1,
  RunCapabilityManifestToolV1,
  RunCapabilityManifestV1,
  RunCapabilityManifestSkillV1,
  SkillSnapshot,
  SkippedCapability
} from '../../../shared/types';
import type { WorkflowHint } from '../../../shared/types';
import { isPlanModeModelVisibleToolName } from '../../services/deep-agent/model-tool-exposure';
import { DEEP_AGENT_BUILT_IN_TOOLS } from '../../services/deep-agent/types';

const deleteFileAllowedDecisions: InterruptDecisionType[] = ['approve', 'edit', 'reject'];
const mcpAllowedDecisions: InterruptDecisionType[] = ['approve', 'reject'];
const runtimeManifestToolNames = [
  'ask_user',
  'cancel_background_task',
  'edit_file',
  'glob',
  'grep',
  'ls',
  'propose_background_task',
  'read_context_artifact',
  'read_background_task',
  'read_file',
  'resolve_background_task_time',
  'schedule_background_task',
  'session_search',
  'task',
  'update_background_task',
  'write_file',
  'write_todos'
] as const;
const reservedMcpModelVisibleToolNames = new Set<string>([
  ...DEEP_AGENT_BUILT_IN_TOOLS,
  ...runtimeManifestToolNames,
  'ask_user',
  'delete_file',
  'execute',
  'run_shell_command',
  'web_read'
]);

export type CompiledRunCapabilityManifest = {
  manifest: RunCapabilityManifestV1;
  toolCards: AgentCapabilityCard[];
  skillCards: AgentCapabilityCard[];
  subagents: AgentSubagentPreview[];
  interruptOn: AgentInterruptPolicy;
};

export function compileRunCapabilityManifest(input: {
  deleteFileApprovalMode: ApprovalMode;
  explicitSkillIds?: readonly string[];
  mcpApprovalMode: ApprovalMode;
  mcpServers: McpServerSnapshot[];
  mode: ChatRunMode;
  shellAllowedCommands?: readonly string[];
  workflowHint: WorkflowHint;
  requestedCapabilities: EnabledCapabilities;
  skills: SkillSnapshot[];
}): CompiledRunCapabilityManifest {
  const requestedCapabilities = normalizeRequestedCapabilities(input.requestedCapabilities);
  const skippedCapabilities: SkippedCapability[] = [];
  const resolvedMcpServers: string[] = [];
  const resolvedSkills: string[] = [];
  const selectedMcpCards: AgentCapabilityCard[] = [];
  const selectedSkills: SkillSnapshot[] = [];

  for (const serverId of requestedCapabilities.mcpServers) {
    const server = input.mcpServers.find((item) => item.id === serverId);
    if (server === undefined) {
      skippedCapabilities.push({ id: serverId, type: 'mcp_server', reason: 'not_found' });
      continue;
    }
    if (!server.enabled) {
      skippedCapabilities.push({ id: serverId, type: 'mcp_server', reason: 'disabled' });
      continue;
    }
    resolvedMcpServers.push(server.id);
    selectedMcpCards.push(...createMcpToolCards(server, input.mcpApprovalMode));
  }

  for (const skillId of requestedCapabilities.skills) {
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
    resolvedSkills.push(skill.id);
    selectedSkills.push(skill);
  }

  const manifestSkills = [...selectedSkills];
  const manifestSkillIds = new Set(selectedSkills.map((skill) => skill.id));
  for (const skillId of normalizeExplicitSkillIds(input.explicitSkillIds)) {
    const skill = input.skills.find((item) => item.id === skillId);
    if (skill === undefined) {
      throw new Error(`skill_not_found:${skillId}`);
    }
    if (!skill.enabled) {
      throw new Error(`skill_disabled:${skillId}`);
    }
    if (skill.status !== 'ready') {
      throw new Error(`skill_invalid:${skillId}`);
    }
    if (manifestSkillIds.has(skill.id)) {
      continue;
    }
    manifestSkillIds.add(skill.id);
    manifestSkills.push(skill);
  }

  const allToolCards = [
    ...(input.shellAllowedCommands === undefined || input.shellAllowedCommands.length > 0
      ? [createRunShellCommandCard()]
      : []),
    createWebReadCard(),
    createDeleteFileCard(input.deleteFileApprovalMode),
    ...selectedMcpCards
  ];
  const toolCards = input.mode === 'plan' ? allToolCards.filter((card) => isPlanModeModelVisibleToolName(card.name)) : allToolCards;
  const interruptOn = createInterruptPolicy({
    deleteFileApprovalMode: input.deleteFileApprovalMode,
    mcpApprovalMode: input.mcpApprovalMode,
    mcpToolNames: toolCards.filter((card) => card.capabilityType === 'mcp_tool').map((card) => card.name),
    modelVisibleToolNames: new Set(toolCards.map((card) => card.name))
  });
  const manifestWithoutHash = {
    schemaVersion: 1 as const,
    requestedCapabilities,
    resolvedCapabilities: {
      mcpServers: resolvedMcpServers,
      skills: resolvedSkills
    },
    skippedCapabilities,
    tools: [
      ...compileManifestTools(toolCards, interruptOn),
      ...createRuntimeManifestTools({
        mode: input.mode,
        workflowHint: input.workflowHint
      })
    ],
    skills: compileManifestSkills(manifestSkills),
    untrustedContextPolicy: 'external_content_reference_only' as const
  };
  const manifest: RunCapabilityManifestV1 = {
    ...manifestWithoutHash,
    manifestHash: createRunCapabilityManifestHash(manifestWithoutHash)
  };

  return {
    manifest,
    toolCards,
    skillCards: manifestSkills.map((skill) => createSkillCard(skill)),
    subagents: createSubagents(manifest),
    interruptOn
  };
}

export function isRunCapabilityManifestIntegrityValid(manifest: RunCapabilityManifestV1): boolean {
  const { manifestHash, ...withoutHash } = manifest;
  return manifestHash === createRunCapabilityManifestHash(withoutHash);
}

function createRunCapabilityManifestHash(input: Omit<RunCapabilityManifestV1, 'manifestHash'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function normalizeRequestedCapabilities(input: EnabledCapabilities): EnabledCapabilities {
  return {
    mcpServers: normalizeCapabilityIds(input.mcpServers, 'mcp_server'),
    skills: normalizeCapabilityIds(input.skills, 'skill')
  };
}

function normalizeCapabilityIds(ids: string[], kind: 'mcp_server' | 'skill'): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const value = id.trim();
    if (value.length === 0) {
      throw new Error(`run_capability_${kind}_id_empty`);
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeExplicitSkillIds(ids: readonly string[] | undefined): string[] {
  if (ids === undefined) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const value = id.trim();
    if (value.length === 0) {
      throw new Error('run_explicit_skill_id_empty');
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function compileManifestTools(
  cards: AgentCapabilityCard[],
  interruptOn: AgentInterruptPolicy
): RunCapabilityManifestToolV1[] {
  const names = new Set<string>();
  return cards.map((card) => {
    if (names.has(card.name)) {
      throw new Error(`run_capability_model_visible_name_collision:${card.name}`);
    }
    names.add(card.name);
    const effectClass = resolveEffectClass(card);
    return {
      canonicalIdentity: card.id,
      modelVisibleName: card.name,
      provenance: resolveProvenance(card),
      executionScopes: ['main', 'subagent'],
      riskLevel: card.riskLevel,
      effectClass,
      approvalPolicy: resolveApprovalPolicy(card.name, interruptOn),
      idempotencyStrategy: effectClass === 'none' ? 'none' : 'tool_call',
      reconcileStrategy: resolveReconcileStrategy(effectClass),
      resourceScope: card.scope
    };
  });
}

function createRuntimeManifestTools(input: {
  mode: ChatRunMode;
  workflowHint: WorkflowHint;
}): RunCapabilityManifestToolV1[] {
  const tools = [
    createRuntimeManifestTool('write_todos', ['main', 'subagent'], 'app', 'none', 'none'),
    createRuntimeManifestTool('task', ['main'], 'app', 'none', 'none'),
    createRuntimeManifestTool('ls', ['main', 'subagent'], 'workspace', 'none', 'none'),
    createRuntimeManifestTool('read_file', ['main', 'subagent'], 'workspace', 'none', 'none'),
    createRuntimeManifestTool('write_file', ['main', 'subagent'], 'workspace', 'workspace_mutation', 'tool_call'),
    createRuntimeManifestTool('edit_file', ['main', 'subagent'], 'workspace', 'workspace_mutation', 'tool_call'),
    createRuntimeManifestTool('glob', ['main', 'subagent'], 'workspace', 'none', 'none'),
    createRuntimeManifestTool('grep', ['main', 'subagent'], 'workspace', 'none', 'none'),
    createRuntimeManifestTool('ask_user', ['main'], 'app', 'none', 'none'),
    createRuntimeManifestTool('session_search', ['main'], 'memory', 'none', 'none'),
    createRuntimeManifestTool('read_context_artifact', ['main', 'subagent'], 'memory', 'none', 'none')
  ];
  if (input.mode === 'plan') {
    return tools;
  }
  if (input.workflowHint === 'propose_background_task') {
    return [
      ...tools,
      createRuntimeManifestTool('resolve_background_task_time', ['main'], 'app', 'none', 'none'),
      createRuntimeManifestTool('propose_background_task', ['main'], 'app', 'external_call', 'tool_call'),
      createRuntimeManifestTool('schedule_background_task', ['main'], 'app', 'external_call', 'tool_call'),
      createRuntimeManifestTool('read_background_task', ['main'], 'app', 'none', 'none')
    ];
  }
  if (input.workflowHint === 'background_task_change') {
    return [
      ...tools,
      createRuntimeManifestTool('read_background_task', ['main'], 'app', 'none', 'none'),
      createRuntimeManifestTool('update_background_task', ['main'], 'app', 'external_call', 'tool_call'),
      createRuntimeManifestTool('cancel_background_task', ['main'], 'app', 'external_call', 'tool_call')
    ];
  }
  return tools;
}

function createRuntimeManifestTool(
  modelVisibleName: string,
  executionScopes: RunCapabilityManifestToolV1['executionScopes'],
  resourceScope: RunCapabilityManifestToolV1['resourceScope'],
  effectClass: RunCapabilityManifestToolV1['effectClass'],
  idempotencyStrategy: RunCapabilityManifestToolV1['idempotencyStrategy']
): RunCapabilityManifestToolV1 {
  return {
    canonicalIdentity: `builtin:${modelVisibleName}`,
    modelVisibleName,
    provenance: { kind: 'builtin', source: 'roc' },
    executionScopes,
    riskLevel: effectClass === 'none' ? 'low' : 'medium',
    effectClass,
    approvalPolicy: { kind: 'none' },
    idempotencyStrategy,
    reconcileStrategy: resolveReconcileStrategy(effectClass),
    resourceScope
  };
}

function resolveReconcileStrategy(
  effectClass: RunCapabilityManifestToolV1['effectClass']
): RunCapabilityManifestToolV1['reconcileStrategy'] {
  if (effectClass === 'none') {
    return 'none';
  }
  if (effectClass === 'network_read') {
    return 'retry_safe';
  }
  return 'manual_confirmation';
}

function compileManifestSkills(skills: SkillSnapshot[]): RunCapabilityManifestSkillV1[] {
  return skills.map((skill) => ({
    canonicalIdentity: `skill:${skill.id}`,
    name: skill.name,
    sourcePath: skill.path,
    description: skill.description
  }));
}

function resolveProvenance(card: AgentCapabilityCard): RunCapabilityManifestToolV1['provenance'] {
  if (card.capabilityType !== 'mcp_tool') {
    return { kind: 'builtin', source: 'roc' };
  }
  const serverId = card.dependencies[0];
  if (serverId === undefined || serverId.trim().length === 0) {
    throw new Error(`run_capability_mcp_provenance_missing:${card.id}`);
  }
  return { kind: 'mcp', serverId };
}

function resolveEffectClass(card: AgentCapabilityCard): RunCapabilityEffectClassV1 {
  if (card.id === 'builtin:run_shell_command') {
    return 'host_execution';
  }
  if (card.id === 'builtin:delete_file') {
    return 'workspace_mutation';
  }
  if (card.id === 'web:web_read' || card.id === 'mcp:exa-hosted:web_search') {
    return 'network_read';
  }
  if (card.capabilityType === 'mcp_tool') {
    return 'external_call';
  }
  return 'none';
}

function resolveApprovalPolicy(name: string, interruptOn: AgentInterruptPolicy): RunCapabilityApprovalPolicyV1 {
  const policy = interruptOn[name];
  if (policy === undefined) {
    return { kind: 'none' };
  }
  if (policy === true) {
    return { kind: 'required', allowedDecisions: [...deleteFileAllowedDecisions] };
  }
  return {
    kind: 'required',
    allowedDecisions: [...policy.allowedDecisions]
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
  return server.allowedTools.map((toolName) => {
    if (reservedMcpModelVisibleToolNames.has(toolName)) {
      throw new Error(`run_capability_model_visible_name_reserved:${toolName}`);
    }
    return {
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
    };
  });
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

function createSubagents(manifest: RunCapabilityManifestV1): AgentSubagentPreview[] {
  return [
    {
      id: 'general-purpose',
      name: 'general-purpose',
      purpose: '处理可委派的通用子任务，并继承本轮允许的工具和 Skill。',
      skills: manifest.skills.map((skill) => skill.canonicalIdentity),
      tools: manifest.tools
        .filter((tool) => tool.executionScopes.includes('subagent'))
        .map((tool) => tool.modelVisibleName)
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

function createWebReadCard(): AgentCapabilityCard {
  return {
    id: 'web:web_read',
    name: 'web_read',
    capabilityType: 'web_read',
    description: '读取公开网页正文；目标 URL 会发送给 Jina Reader 代理，结果带来源、抓取时间、SHA-256 和不可信标记。',
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
    description: '以当前 Windows 用户权限执行宿主机 PowerShell 命令，由 Roc 的 RTK、审计、取消与输出限制统一包裹。',
    requiredInput: 'PowerShell command',
    scope: 'external',
    dependencies: ['ShellExecutionService', 'RtkService'],
    sideEffects: ['host_code_execution', 'task_trace_audit'],
    requiresApproval: false,
    supportsLongTermGrant: false,
    revokeGrantHint: 'run_shell_command 由 Roc 内置工具提供，不创建长期授权。',
    riskLevel: 'critical',
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
    requiredInput: 'file_path: /workspace/...',
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

function createInterruptPolicy(input: {
  deleteFileApprovalMode: ApprovalMode;
  mcpApprovalMode: ApprovalMode;
  mcpToolNames: string[];
  modelVisibleToolNames: Set<string>;
}): AgentInterruptPolicy {
  const policy: AgentInterruptPolicy = {};
  if (input.deleteFileApprovalMode === 'default' && input.modelVisibleToolNames.has('delete_file')) {
    policy.delete_file = {
      allowedDecisions: [...deleteFileAllowedDecisions]
    };
  }
  if (input.mcpApprovalMode === 'default') {
    for (const toolName of input.mcpToolNames) {
      policy[toolName] = {
        allowedDecisions: [...mcpAllowedDecisions]
      };
    }
  }
  return policy;
}
