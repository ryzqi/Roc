import type {
  AgentCapabilityCard,
  ApprovalMode,
  ChatRunMode,
  McpServerSnapshot,
  SkillSnapshot
} from '../../../shared/types';

/**
 * 工具选择策略：决定哪些工具应该包含在 manifest 中
 *
 * Seam: 这是 manifest 编译器的关键 adapter 接口。
 * 不同策略可以产生不同的工具集合（plan mode / normal mode / custom）。
 */
export interface ToolSelectionPolicy {
  /**
   * 选择应该包含的工具卡片
   * @returns 选中的工具卡片数组
   */
  selectToolCards(context: ToolSelectionContext): AgentCapabilityCard[];
}

export type ToolSelectionContext = {
  mode: ChatRunMode;
  deleteFileApprovalMode: ApprovalMode;
  mcpApprovalMode: ApprovalMode;
  mcpServers: McpServerSnapshot[];
  selfConfigAvailable: boolean;
  shellAllowedCommands: readonly string[] | undefined;
};

/**
 * 默认工具选择策略：
 * - shell: 当 shellAllowedCommands 未定义或非空数组时包含
 * - web_read: 总是包含
 * - delete_file: 总是包含
 * - self_config: 仅 normal mode 且 selfConfigAvailable 时包含
 * - MCP 工具: 根据 mcpServers 和 mcpApprovalMode 生成
 * - plan mode: 过滤只保留 plan mode 可见的工具
 */
export class DefaultToolSelectionPolicy implements ToolSelectionPolicy {
  selectToolCards(context: ToolSelectionContext): AgentCapabilityCard[] {
    const cards: AgentCapabilityCard[] = [];

    // Shell command card
    if (context.shellAllowedCommands === undefined || context.shellAllowedCommands.length > 0) {
      cards.push(this.createRunShellCommandCard());
    }

    // Web read card (always)
    cards.push(this.createWebReadCard());

    // Delete file card (always, approval controlled by mode)
    cards.push(this.createDeleteFileCard(context.deleteFileApprovalMode));

    // Self config card (only in normal mode when available)
    if (context.mode !== 'plan' && context.selfConfigAvailable) {
      cards.push(this.createSelfConfigCard());
    }

    // MCP tool cards
    for (const server of context.mcpServers) {
      if (server.enabled) {
        cards.push(...this.createMcpToolCards(server, context.mcpApprovalMode));
      }
    }

    // Plan mode filter
    if (context.mode === 'plan') {
      return cards.filter((card) => this.isPlanModeVisible(card.name));
    }

    return cards;
  }

  private isPlanModeVisible(toolName: string): boolean {
    // 从 deep-agent/model-tool-exposure 导入的逻辑
    // 这里暂时内联，后续可以注入依赖
    const planModeAllowedTools = new Set([
      'read_file',
      'write_file',
      'edit_file',
      'ls',
      'glob',
      'grep',
      'web_read',
      'ask_user'
    ]);
    return planModeAllowedTools.has(toolName);
  }

  private createRunShellCommandCard(): AgentCapabilityCard {
    return {
      id: 'builtin:run_shell_command',
      name: 'run_shell_command',
      capabilityType: 'terminal_tool',
      description: '以当前 Windows 用户权限执行 PowerShell；由 Roc 统一处理 RTK、审计、取消和输出限制。',
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

  private createWebReadCard(): AgentCapabilityCard {
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

  private createSelfConfigCard(): AgentCapabilityCard {
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

  private createDeleteFileCard(approvalMode: ApprovalMode): AgentCapabilityCard {
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

  private createMcpToolCards(server: McpServerSnapshot, approvalMode: ApprovalMode): AgentCapabilityCard[] {
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
      'resolve_background_task_time',
      'roc_self_config',
      'run_shell_command',
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
}
