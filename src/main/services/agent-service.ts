import { createDeepAgent } from 'deepagents';
import type {
  ApprovalMode,
  AgentInterruptPolicy,
  AgentCapabilityCard,
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  AgentSubagentPreview,
  DeepAgentConfigPreview,
  EnabledCapabilities,
  InterruptDecisionType,
  McpServerSnapshot,
  SkillSnapshot,
  SkippedCapability
} from '../../shared/types';
import type { ConfigService } from './config-service';
import { DEEP_AGENT_BUILT_IN_TOOLS } from './deep-agent/types';
import type { McpService } from './mcp-service';
import type { SkillService } from './skill-service';

export class AgentService {
  private static readonly DELETE_FILE_ALLOWED_DECISIONS: ReadonlyArray<InterruptDecisionType> = [
    'approve',
    'edit',
    'reject'
  ];

  private static readonly MCP_ALLOWED_DECISIONS: ReadonlyArray<InterruptDecisionType> = ['approve', 'reject'];
  private static readonly BACKGROUND_TASK_ALLOWED_DECISIONS: ReadonlyArray<InterruptDecisionType> = [
    'approve',
    'edit',
    'reject'
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly mcpService: McpService,
    private readonly skillService: SkillService
  ) {}

  getStatus(): AgentRuntimeStatus {
    const defaultModelState = this.configService.getDefaultModelState();
    const defaultModelConfigured = defaultModelState.status === 'ready';

    return {
      deepAgentsPackage: 'available',
      deepAgentsApi: {
        createDeepAgent: typeof createDeepAgent === 'function'
      },
      defaultModelConfigured,
      defaultModelState,
      memoryAccess: 'store_backend',
      execution: defaultModelConfigured ? 'ready' : 'blocked_until_provider_configured'
    };
  }

  getDeepAgentConfigPreview(): DeepAgentConfigPreview {
    const defaultModelState = this.configService.getDefaultModelState();
    if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null) {
      throw this.configService.createDefaultModelError(defaultModelState);
    }

    const approvalMode = this.getApprovalMode();
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
      interruptOn: this.createInterruptPolicy(approvalMode, []),
      reason: 'Roc 不在 preview 阶段实际装配 Deep Agents，本结果反映下一轮装配将使用的参数。'
    };
  }

  getCapabilityPreview(requestedCapabilities: EnabledCapabilities): AgentCapabilityPreview {
    const defaultModelState = this.configService.getDefaultModelState();
    if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null) {
      throw this.configService.createDefaultModelError(defaultModelState);
    }

    const mcpServers = this.mcpService.listServers();
    const skills = this.skillService.list();
    const approvalMode = this.getApprovalMode();
    const skippedCapabilities: SkippedCapability[] = [];
    const selectedMcpServers: string[] = [];
    const selectedSkills: string[] = [];
    const selectedMcpCards: AgentCapabilityCard[] = [];
    const selectedSkillCards: AgentCapabilityCard[] = [];

    for (const serverId of requestedCapabilities.mcpServers) {
      const server = mcpServers.find((item) => item.id === serverId);
      if (server === undefined) {
        skippedCapabilities.push({ id: serverId, type: 'mcp_server', reason: 'not_found' });
        continue;
      }
      if (!server.enabled) {
        skippedCapabilities.push({ id: serverId, type: 'mcp_server', reason: 'disabled' });
        continue;
      }
      selectedMcpServers.push(server.id);
      selectedMcpCards.push(...this.createMcpToolCards(server, approvalMode));
    }

    for (const skillId of requestedCapabilities.skills) {
      const skill = skills.find((item) => item.id === skillId);
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
      selectedSkillCards.push(this.createSkillCard(skill));
    }

    const webReadCard = this.createWebReadCard();
    const executeCard = this.createExecuteCard();
    const deleteFileCard = this.createDeleteFileCard(approvalMode);
    const toolCards = [
      executeCard,
      webReadCard,
      deleteFileCard,
      this.createBackgroundTaskCard('read_background_task', '读取已有后台任务定义。', false, ['background_task_read']),
      this.createBackgroundTaskCard('confirm_with_user', '总结后台任务创建结果并结束本轮。', false, [
        'user_confirmation_message'
      ]),
      this.createBackgroundTaskCard('propose_background_task', '生成后台任务 preview，不实际创建。', false, [
        'background_task_preview'
      ]),
      this.createBackgroundTaskCard('schedule_background_task', '把后台任务 preview 实际创建并加入调度。', false, [
        'background_task_create'
      ]),
      this.createBackgroundTaskCard('update_background_task', '提议修改已有后台任务。', true, [
        'background_task_change_request'
      ]),
      this.createBackgroundTaskCard('cancel_background_task', '提议取消已有后台任务。', true, [
        'background_task_change_request'
      ]),
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
      requestedCapabilities,
      skippedCapabilities,
      toolCards,
      skillCards: selectedSkillCards,
      subagents: this.createSubagents(),
      interruptOn: this.createInterruptPolicy(
        approvalMode,
        selectedMcpCards.map((card) => card.name)
      ),
      untrustedContextPolicy: 'external_content_reference_only',
      reason: '当前仅生成本轮能力清单预览，实际运行时才会装配 Deep Agents。'
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
          description: '搜索公开网络信息，返回可继续阅读和核实的结果列表。',
          requiredInput: 'query',
          scope: 'external',
          dependencies: [server.id],
          sideEffects: ['external_tool_call'],
          requiresApproval,
          supportsLongTermGrant: true,
          revokeGrantHint: `${approvalHint} supportsLongTermGrant 仅表示可长期保留该能力授权。`,
          riskLevel: server.riskLevel ?? 'medium',
          auditCategory: 'mcp_call',
          untrustedContext: true
        }
      ];
    }
    const allowedTools = server.allowedTools;
    if (allowedTools === undefined) {
      return [];
    }
    return allowedTools.map((toolName) => ({
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
      riskLevel: server.riskLevel ?? 'medium',
      auditCategory: 'mcp_call',
      untrustedContext: true
    }));
  }

  private createSkillCard(skill: SkillSnapshot): AgentCapabilityCard {
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

  private createWebReadCard(): AgentCapabilityCard {
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

  private createExecuteCard(): AgentCapabilityCard {
    return {
      id: 'builtin:execute',
      name: 'execute',
      capabilityType: 'terminal_tool',
      description: '通过 Deep Agents 内建 execute 在当前工作区执行命令，由 Roc 的 RTK 与审计层统一包裹。',
      requiredInput: 'shell command',
      scope: 'workspace',
      dependencies: ['LocalShellBackend', 'RtkService'],
      sideEffects: ['workspace_command_execution', 'task_trace_audit'],
      requiresApproval: false,
      supportsLongTermGrant: false,
      revokeGrantHint: 'execute 由 Roc 内置 backend 提供，不创建长期授权。',
      riskLevel: 'medium',
      auditCategory: 'agent_execute',
      untrustedContext: false
    };
  }

  private createDeleteFileCard(approvalMode: ApprovalMode): AgentCapabilityCard {
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

  private createBackgroundTaskCard(
    name: string,
    description: string,
    requiresApproval: boolean,
    sideEffects: string[]
  ): AgentCapabilityCard {
    return {
      id: `builtin:${name}`,
      name,
      capabilityType: 'terminal_tool',
      description,
      requiredInput: 'background task structured request',
      scope: 'app',
      dependencies: ['TaskService', 'TaskSchedulerService'],
      sideEffects,
      requiresApproval,
      supportsLongTermGrant: false,
      revokeGrantHint: requiresApproval ? '后台任务修改和取消始终需要本次审批。' : '后台任务工具由 Roc 内置提供，不创建长期授权。',
      riskLevel: 'high',
      auditCategory: 'background_task',
      untrustedContext: false
    };
  }

  private createSubagents(): AgentSubagentPreview[] {
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

  private getApprovalMode(): ApprovalMode {
    return this.configService.getPermissions().mode;
  }

  private createInterruptPolicy(approvalMode: ApprovalMode, mcpToolNames: string[]): AgentInterruptPolicy {
    const policy: AgentInterruptPolicy = {
      update_background_task: {
        allowedDecisions: [...AgentService.BACKGROUND_TASK_ALLOWED_DECISIONS]
      },
      cancel_background_task: {
        allowedDecisions: ['approve', 'reject']
      }
    };
    if (approvalMode === 'fully_automatic') {
      return policy;
    }
    policy.delete_file = {
      allowedDecisions: [...AgentService.DELETE_FILE_ALLOWED_DECISIONS]
    };
    for (const toolName of mcpToolNames) {
      policy[toolName] = {
        allowedDecisions: [...AgentService.MCP_ALLOWED_DECISIONS]
      };
    }
    return policy;
  }
}
