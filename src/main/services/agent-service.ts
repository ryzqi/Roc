import { createDeepAgent } from 'deepagents';
import type {
  ApprovalMode,
  AgentCapabilityCard,
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  AgentSubagentPreview,
  DeepAgentConfigPreview,
  EnabledCapabilities,
  McpServerSnapshot,
  SkillSnapshot,
  SkippedCapability
} from '../../shared/types';
import type { ConfigService } from './config-service';
import type { McpService } from './mcp-service';
import type { SkillService } from './skill-service';

export class AgentService {
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
      memoryAccess: 'memory_service_only',
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
      memoryAccess: 'memory_service_only',
      builtInTools: ['write_todos', 'task', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute'],
      rocTools: ['memory_search', 'memory_get'],
      todoMapping: {
        sourceTool: 'write_todos',
        target: 'task_steps'
      },
      interruptOn: this.createInterruptPolicy(approvalMode, []),
      reason: 'W2 只装配配置预览，不执行 Deep Agents run。'
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
    const memoryCards = this.createMemoryCards();
    const toolCards = [...memoryCards, executeCard, webReadCard, deleteFileCard, ...selectedMcpCards];

    return {
      runnable: false,
      modelId: defaultModelState.modelId,
      builtInTools: ['write_todos', 'task', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute'],
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

  private createMemoryCards(): AgentCapabilityCard[] {
    return [
      {
        id: 'memory:memory_search',
        name: 'memory_search',
        capabilityType: 'memory_tool',
        description: '检索 Roc 长期记忆与会话回忆，返回相关条目摘要列表。',
        requiredInput: 'query and optional scope',
        scope: 'memory',
        dependencies: ['MemoryService'],
        sideEffects: [],
        requiresApproval: false,
        supportsLongTermGrant: false,
        revokeGrantHint: '记忆工具由 Roc 内置边界提供，不创建长期授权。',
        riskLevel: 'low',
        auditCategory: 'memory_operation',
        untrustedContext: false
      },
      {
        id: 'memory:memory_get',
        name: 'memory_get',
        capabilityType: 'memory_tool',
        description: '读取指定 Roc 记忆条目的 Markdown 原文。',
        requiredInput: 'memory id',
        scope: 'memory',
        dependencies: ['MemoryService'],
        sideEffects: [],
        requiresApproval: false,
        supportsLongTermGrant: false,
        revokeGrantHint: '记忆工具由 Roc 内置边界提供，不创建长期授权。',
        riskLevel: 'low',
        auditCategory: 'memory_operation',
        untrustedContext: false
      }
    ];
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

  private createSubagents(): AgentSubagentPreview[] {
    return [
      {
        id: 'code-review',
        name: '代码审查子任务',
        purpose: '隔离审查上下文，并把 bug、风险与缺失验证回流主任务轨迹。',
        inheritsSkills: false,
        tools: ['memory_search', 'memory_get']
      },
      {
        id: 'research',
        name: '资料检索子任务',
        purpose: '围绕网页阅读整理外部资料结论，并明确来源边界。',
        inheritsSkills: false,
        tools: ['web_read']
      }
    ];
  }

  private getApprovalMode(): ApprovalMode {
    return this.configService.getPermissions().mode;
  }

  private createInterruptPolicy(approvalMode: ApprovalMode, mcpToolNames: string[]): Record<string, boolean> {
    if (approvalMode === 'fully_automatic') {
      return {};
    }
    const policy: Record<string, boolean> = {
      delete_file: true
    };
    for (const toolName of mcpToolNames) {
      policy[toolName] = true;
    }
    return policy;
  }
}
