import { mcpServerConfigSchema } from '../../../shared/schemas/ipc-mcp-skills';
import { readSkillRevision } from '../../services/skill-revision';
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
import { selectToolCards } from './tool-selection-policy';
import { RESEARCH_TOOL_DESCRIPTORS } from './research-tools';

const deleteFileAllowedDecisions: InterruptDecisionType[] = ['approve', 'edit', 'reject'];
const selfConfigCardId = 'builtin:roc_self_config';
const mcpAllowedDecisions: InterruptDecisionType[] = ['approve', 'reject'];
export type CompiledRunCapabilityManifest = {
  manifest: RunCapabilityManifestV1;
  toolCards: AgentCapabilityCard[];
  skillCards: AgentCapabilityCard[];
  subagents: AgentSubagentPreview[];
  interruptOn: AgentInterruptPolicy;
};

export function compileRunCapabilityManifest(input: {
  mode: ChatRunMode;
  deleteFileApprovalMode: ApprovalMode;
  mcpApprovalMode: ApprovalMode;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
  explicitSkillIds?: readonly string[];
  selfConfigAvailable?: boolean;
  shellAllowedCommands?: readonly string[];
  workflowHint: WorkflowHint;
  requestedCapabilities: EnabledCapabilities;
  researchProjectId?: string | null;
}): CompiledRunCapabilityManifest {
  const requestedCapabilities = normalizeRequestedCapabilities(input.requestedCapabilities);
  const skippedCapabilities: SkippedCapability[] = [];
  const resolvedMcpServers: string[] = [];
  const resolvedSkills: string[] = [];
  const selectedSkills: SkillSnapshot[] = [];

  // 解析请求的 MCP 服务器
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
  }

  // 解析请求的技能
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

  // 添加显式技能
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

  const toolCards = selectToolCards({
    mode: input.mode,
    deleteFileApprovalMode: input.deleteFileApprovalMode,
    mcpApprovalMode: input.mcpApprovalMode,
    mcpServers: input.mcpServers,
    selfConfigAvailable: input.selfConfigAvailable ?? false,
    shellAllowedCommands: input.shellAllowedCommands
  });

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
      }),
      ...createResearchManifestTools({
        mode: input.mode,
        researchProjectId: input.researchProjectId ?? null
      })
    ],
    skills: compileManifestSkills(manifestSkills),
    mcpServers: input.mcpServers.filter(server => resolvedMcpServers.includes(server.id)).map(server =>
      mcpServerConfigSchema.parse({ id: server.id, name: server.name, enabled: server.enabled, transport: server.transport,
        preset: server.preset, riskLevel: server.riskLevel, url: server.url, command: server.command, allowedTools: server.allowedTools })),
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

export function createRunCapabilityManifestHash(input: Omit<RunCapabilityManifestV1, 'manifestHash'>): string {
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
      executionScopes: resolveExecutionScopes(card),
      riskLevel: card.riskLevel,
      effectClass,
      approvalPolicy: resolveApprovalPolicy(card.name, interruptOn),
      idempotencyStrategy: effectClass === 'none' ? 'none' : 'tool_call',
      reconcileStrategy: resolveReconcileStrategy(effectClass),
      resourceScope: card.scope
    };
  });
}

/**
 * 绑定研究项目的对话运行额外拿到科研工具。工具名、资源域和副作用等级都从 research-tools 的描述表读，
 * 避免 manifest 与真实装配的工具两处漂移。计划模式不装配副作用工具。
 */
function createResearchManifestTools(input: {
  mode: ChatRunMode;
  researchProjectId: string | null;
}): RunCapabilityManifestToolV1[] {
  if (input.researchProjectId === null || input.mode === 'plan') {
    return [];
  }
  return RESEARCH_TOOL_DESCRIPTORS.map((descriptor) => ({
    canonicalIdentity: `research:${descriptor.name}`,
    modelVisibleName: descriptor.name,
    provenance: { kind: 'builtin' as const, source: 'roc' as const },
    executionScopes: [...descriptor.executionScopes],
    riskLevel: descriptor.riskLevel,
    effectClass: descriptor.effectClass,
    approvalPolicy: { kind: 'none' as const },
    idempotencyStrategy: descriptor.effectClass === 'none' ? ('none' as const) : ('tool_call' as const),
    reconcileStrategy: ['research_add_literature', 'research_cancel_literature_import'].includes(descriptor.name)
      ? 'retry_safe' : resolveReconcileStrategy(descriptor.effectClass),
    resourceScope: descriptor.scope
  }));
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
    createRuntimeManifestTool('memory_search', ['main'], 'memory', 'none', 'none'),
    createRuntimeManifestTool('remember', ['main'], 'memory', 'external_call', 'tool_call'),
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
  return skills.map(skill => {
    const revision = readSkillRevision(skill.path);
    return { canonicalIdentity: `skill:${skill.id}`, name: skill.name, sourcePath: skill.path,
      description: skill.description, contentHash: revision.contentHash, license: revision.license,
      licenseHash: revision.licenseHash, sourceRevision: skill.upstreamCommit };
  });
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

function resolveExecutionScopes(card: AgentCapabilityCard): RunCapabilityManifestToolV1['executionScopes'] {
  if (card.id === selfConfigCardId) {
    return ['main'];
  }
  return ['main', 'subagent'];
}

function resolveEffectClass(card: AgentCapabilityCard): RunCapabilityEffectClassV1 {
  if (card.id === 'builtin:run_shell_command' || card.id === selfConfigCardId) {
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
      purpose: '处理可委派子任务，继承本轮允许的工具和 Skill。',
      skills: manifest.skills.map((skill) => skill.canonicalIdentity),
      tools: manifest.tools
        .filter((tool) => tool.executionScopes.includes('subagent'))
        .map((tool) => tool.modelVisibleName)
    },
    {
      id: 'research',
      name: '资料检索子任务',
      purpose: '阅读网页并整理带来源的外部结论。',
      skills: [],
      tools: ['web_read']
    }
  ];
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
