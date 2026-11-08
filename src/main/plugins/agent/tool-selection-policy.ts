import type {
  AgentCapabilityCard,
  ApprovalMode,
  ChatRunMode,
  McpServerSnapshot
} from '../../../shared/types';
import { isPlanModeModelVisibleToolName } from '../../services/deep-agent/model-tool-exposure';

export type ToolSelectionContext = {
  mode: ChatRunMode;
  deleteFileApprovalMode: ApprovalMode;
  mcpApprovalMode: ApprovalMode;
  mcpServers: McpServerSnapshot[];
  selfConfigAvailable: boolean;
  shellAllowedCommands: readonly string[] | undefined;
  trustedHostAvailable: boolean;
};

export function selectToolCards(context: ToolSelectionContext): AgentCapabilityCard[] {
  const cards: AgentCapabilityCard[] = [];

  if (context.mode !== 'plan' && (context.shellAllowedCommands === undefined || context.shellAllowedCommands.length > 0)) {
    cards.push(createRunShellCommandCard());
    cards.push(createIsolatedReadCommandCard());
  }
  if (context.mode !== 'plan' && context.trustedHostAvailable) {
    cards.push(createTrustedHostCommandCard());
  }

  cards.push(createWebReadCard());

  cards.push(createDeleteFileCard(context.deleteFileApprovalMode));

  if (context.mode !== 'plan' && context.selfConfigAvailable) {
    cards.push(createSelfConfigCard());
  }

  for (const server of context.mcpServers) {
    if (server.enabled) {
      cards.push(...createMcpToolCards(server, context.mcpApprovalMode));
    }
  }

  if (context.mode === 'plan') {
    return cards.filter((card) => isPlanModeModelVisibleToolName(card.name));
  }

  return cards;
}

function createRunShellCommandCard(): AgentCapabilityCard {
  return {
    id: 'builtin:run_shell_command',
    name: 'run_shell_command',
    capabilityType: 'terminal_tool',
    description: '在隔离工作区内执行 zsh；写入权限仅限当前工作区，网络默认禁止，时限和输出受限。文件读写优先使用 Roc 文件工具。',
    requiredInput: 'zsh command',
    scope: 'workspace',
    dependencies: ['ExecutionGrantBroker', 'MacOsIsolatedEnvironment'],
    sideEffects: ['isolated_code_execution', 'workspace_mutation'],
    requiresApproval: false,
    supportsLongTermGrant: false,
    revokeGrantHint: 'run_shell_command 的每次执行都使用短时单次工作区隔离授权。',
    riskLevel: 'critical',
    auditCategory: 'agent_execute',
    untrustedContext: false
  };
}

function createIsolatedReadCommandCard(): AgentCapabilityCard {
  return {
    id: 'builtin:run_isolated_read_command',
    name: 'run_isolated_read_command',
    capabilityType: 'terminal_tool',
    description: '在工作区只读、网络禁止的隔离环境中执行 zsh；临时输出和时限受限。',
    requiredInput: 'zsh command',
    scope: 'workspace',
    dependencies: ['ExecutionGrantBroker', 'MacOsIsolatedEnvironment'],
    sideEffects: ['isolated_code_execution'],
    requiresApproval: false,
    supportsLongTermGrant: false,
    revokeGrantHint: 'run_isolated_read_command 的每次执行都使用短时单次授权。',
    riskLevel: 'medium',
    auditCategory: 'agent_execute',
    untrustedContext: false
  };
}

function createTrustedHostCommandCard(): AgentCapabilityCard {
  return {
    id: 'builtin:run_trusted_host_command',
    name: 'run_trusted_host_command',
    capabilityType: 'terminal_tool',
    description: '请求一次本机 shell 执行。运行前会显示完整命令和工作目录，并等待明确确认。',
    requiredInput: 'zsh command',
    scope: 'external',
    dependencies: ['ExecutionGrantBroker', 'native confirmation dialog'],
    sideEffects: ['host_code_execution', 'task_trace_audit'],
    requiresApproval: true,
    supportsLongTermGrant: false,
    revokeGrantHint: '每次调用都需要新的明确确认。',
    riskLevel: 'critical',
    auditCategory: 'agent_execute',
    untrustedContext: false
  };
}

function createWebReadCard(): AgentCapabilityCard {
  return {
    id: 'web:web_read',
    name: 'web_read',
    capabilityType: 'web_read',
    description: '读取公开网页正文；返回来源、抓取时间、SHA-256 和不可信标记。',
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

function createSelfConfigCard(): AgentCapabilityCard {
  return {
    id: 'builtin:roc_self_config',
    name: 'roc_self_config',
    capabilityType: 'terminal_tool',
    description:
      '只读检查 Roc 配置：返回路径、hooks schema/契约、当前快照与脱敏 settings；可校验配置或在确认后试跑现有 handler。不写配置。',
    requiredInput: "action: describe | read | validate | dry_run（validate 需 config，dry_run 需 handlerId）",
    scope: 'app',
    dependencies: ['SelfConfigService', 'HookConfigService', 'HookCommandRunner'],
    sideEffects: ['host_code_execution'],
    requiresApproval: false,
    supportsLongTermGrant: false,
    revokeGrantHint: 'roc_self_config 由 Roc 内置服务提供，不创建长期授权；dry_run 每次都单独确认。',
    riskLevel: 'high',
    auditCategory: 'agent_self_config',
    untrustedContext: false
  };
}

function createDeleteFileCard(approvalMode: ApprovalMode): AgentCapabilityCard {
  return {
    id: 'builtin:delete_file',
    name: 'delete_file',
    capabilityType: 'terminal_tool',
    description: '删除当前工作区文件或空目录；删除前写入恢复点。',
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
        description: '搜索公开网络，返回可阅读和核实的结果。',
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

  const reservedNames = new Set([
    'ask_user',
    'cancel_background_task',
    'delete_file',
    'edit_file',
    'execute',
    'glob',
    'grep',
    'ls',
    'memory_search',
    'propose_background_task',
    'read_background_task',
    'read_context_artifact',
    'read_file',
    'remember',
    'research_approve_gate',
    'research_cancel_stage_run',
    'research_capture_evidence',
    'research_lint_manuscript',
    'research_list_artifacts',
    'research_list_evidence',
    'research_overview',
    'research_read_artifact',
    'research_run_stage',
    'research_search_knowledge',
    'research_wiki_search',
    'research_wiki_read',
    'research_wiki_follow',
    'research_wiki_lint',
    'research_wiki_create',
    'research_wiki_draft',
    'research_search_literature',
    'research_read_literature_search',
    'research_add_literature',
    'research_get_literature_import',
    'research_cancel_literature_import',
    'research_stage_runs',
    'resolve_background_task_time',
    'roc_self_config',
    'run_shell_command',
    'run_isolated_read_command',
    'run_trusted_host_command',
    'schedule_background_task',
    'session_search',
    'task',
    'update_background_task',
    'web_read',
    'write_file',
    'write_todos'
  ]);

  return server.allowedTools.map((toolName) => {
    if (reservedNames.has(toolName)) {
      throw new Error(`run_capability_model_visible_name_reserved:${toolName}`);
    }
    return {
      id: `mcp:${server.id}:${toolName}`,
      name: toolName,
      capabilityType: 'mcp_tool',
      description: `${server.name} 的 ${toolName} 调用入口。`,
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
