import type {
  AgentCapabilityCard,
  AgentInterruptPolicy,
  AgentSubagentPreview,
  ApprovalMode,
  ChatRunMode,
  EnabledCapabilities,
  McpServerSnapshot,
  RunCapabilityManifestV1,
  SkillSnapshot,
  WorkflowHint
} from '../../../shared/types';
import type { CompiledRunCapabilityManifest } from './run-capability-manifest';
import { buildManifestFromPolicy } from './run-capability-manifest';
import { DefaultToolSelectionPolicy, type ToolSelectionPolicy } from './tool-selection-policy';

/**
 * Manifest 构建器：使用 Builder pattern 隐藏复杂的参数组合
 *
 * Depth: 调用方从 10 个参数降为 2-3 个链式调用
 * Locality: 工具选择逻辑集中在 ToolSelectionPolicy
 * Seam: 策略对象是清晰的 adapter seam
 */
export class ManifestBuilder {
  private mode: ChatRunMode = 'chat';
  private deleteFileApprovalMode: ApprovalMode = 'fully_automatic';
  private mcpApprovalMode: ApprovalMode = 'fully_automatic';
  private mcpServers: McpServerSnapshot[] = [];
  private skills: SkillSnapshot[] = [];
  private explicitSkillIds?: readonly string[];
  private selfConfigAvailable = false;
  private shellAllowedCommands?: readonly string[];
  private workflowHint: WorkflowHint = null;
  private requestedCapabilities: EnabledCapabilities = { mcpServers: [], skills: [] };
  private toolSelectionPolicy: ToolSelectionPolicy = new DefaultToolSelectionPolicy();

  /**
   * 静态工厂：为指定模式创建 builder
   */
  static forMode(mode: ChatRunMode): ManifestBuilder {
    const builder = new ManifestBuilder();
    builder.mode = mode;
    return builder;
  }

  /**
   * 设置 MCP 服务器和审批模式
   */
  withMcp(servers: McpServerSnapshot[], approvalMode: ApprovalMode = 'fully_automatic'): this {
    this.mcpServers = servers;
    this.mcpApprovalMode = approvalMode;
    return this;
  }

  /**
   * 设置技能
   */
  withSkills(skills: SkillSnapshot[]): this {
    this.skills = skills;
    return this;
  }

  /**
   * 设置显式技能 ID（用于强制包含某些技能）
   */
  withExplicitSkills(skillIds: readonly string[]): this {
    this.explicitSkillIds = skillIds;
    return this;
  }

  /**
   * 设置 delete_file 审批模式
   */
  withDeleteFileApproval(mode: ApprovalMode): this {
    this.deleteFileApprovalMode = mode;
    return this;
  }

  /**
   * 设置 shell 命令白名单
   */
  withShellCommands(allowedCommands: readonly string[] | undefined): this {
    this.shellAllowedCommands = allowedCommands;
    return this;
  }

  /**
   * 启用 self config 工具
   */
  withSelfConfig(available: boolean): this {
    this.selfConfigAvailable = available;
    return this;
  }

  /**
   * 设置 workflow hint
   */
  withWorkflowHint(hint: WorkflowHint): this {
    this.workflowHint = hint;
    return this;
  }

  /**
   * 设置请求的能力
   */
  withRequestedCapabilities(capabilities: EnabledCapabilities): this {
    this.requestedCapabilities = capabilities;
    return this;
  }

  /**
   * 注入自定义工具选择策略（用于测试或特殊场景）
   */
  withToolSelectionPolicy(policy: ToolSelectionPolicy): this {
    this.toolSelectionPolicy = policy;
    return this;
  }

  /**
   * 构建 manifest
   */
  build(): CompiledRunCapabilityManifest {
    return buildManifestFromPolicy({
      mode: this.mode,
      deleteFileApprovalMode: this.deleteFileApprovalMode,
      mcpApprovalMode: this.mcpApprovalMode,
      mcpServers: this.mcpServers,
      skills: this.skills,
      explicitSkillIds: this.explicitSkillIds,
      selfConfigAvailable: this.selfConfigAvailable,
      shellAllowedCommands: this.shellAllowedCommands,
      workflowHint: this.workflowHint,
      requestedCapabilities: this.requestedCapabilities,
      toolSelectionPolicy: this.toolSelectionPolicy
    });
  }
}
