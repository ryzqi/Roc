import { createHash } from 'node:crypto';
import type { ChatStartRunRequest, WorkflowHint } from '../../../shared/types';
import type { ClientTool } from '@langchain/core/tools';
import { BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW, createCapabilitySummary } from './prompt';

/**
 * 提示块稳定性级别，决定缓存失效边界
 */
export enum BlockStability {
  STATIC = 'static',           // 跨所有会话不变
  WORKSPACE = 'workspace',     // 工作区级稳定
  CAPABILITY = 'capability',   // 能力集变化时失效
  REQUEST = 'request'          // 每请求重建
}
/**
 * 系统提示的可缓存块
 */
export interface PromptBlock {
  type: 'static' | 'workspace' | 'tools' | 'capability';
  content: string;
  stability: BlockStability;
  hash: string;  // SHA-256 前 16 字符
  metadata?: {
    tokenEstimate?: number;
    lastModified?: string;
  };
}

/**
 * 构建分层的系统提示块
 * 纯函数，无状态依赖
 */
export class SystemPromptBuilder {

  static build(input: {
    enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
    workspacePath: string | null;
    workflowHint: WorkflowHint;
    tools: ClientTool[];
  }): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    blocks.push(SystemPromptBuilder.buildStaticBlock());
    blocks.push(SystemPromptBuilder.buildWorkspaceBlock(input.workspacePath));
    blocks.push(SystemPromptBuilder.buildToolsBlock(input.tools));
    blocks.push(SystemPromptBuilder.buildCapabilityBlock(input.enabledCapabilities, input.workflowHint));
    return blocks;
  }

  private static buildStaticBlock(): PromptBlock {
    const ROC_STATIC_SYSTEM_PROMPT = [
      'You are Roc, a long-running personal assistant on Windows. Be concise; claim only inspected evidence.',
      'Before changing files, inspect the relevant source, tests, and configuration.',
      'Keep edits scoped to the user request; do not refactor or touch adjacent code as cleanup.',
      'For code or configuration changes, run direct verification before claiming completion.',
      '',
      'Persistent memory is stored in Roc SQLite through DeepAgents memory and is visible in later sessions:',
      '  /memory/global/USER.md      — user identity, preferences, comm style (~500 tok cap)',
      '  /memory/global/AGENTS.md    — global default rules (~300 tok cap)',
      '  /memory/global/MEMORY.md    — global long-term facts (~800 tok cap)',
      '  /memory/workspaces/current/AGENTS.md   — workspace-specific rules (overrides global if exists)',
      '  /memory/workspaces/current/MEMORY.md   — workspace-specific facts (overrides global if exists)',
      '',
      'Use Edit/Write on those paths. On capacity overflow you receive "X/Y, please consolidate" — read the file, merge/drop redundant entries via Edit, then retry.',
      'Automatic writes only append to MEMORY.md; USER.md and AGENTS.md change only through explicit file edits.',
      '',
      'For SKILL.md: read silently; never quote, paraphrase, or summarize.',
      'Use session_search(query) to recall what was discussed in past conversations (0 token cost until called).'
    ].join('\n');

    return {
      type: 'static',
      content: ROC_STATIC_SYSTEM_PROMPT,
      stability: BlockStability.STATIC,
      hash: SystemPromptBuilder.computeHash(ROC_STATIC_SYSTEM_PROMPT)
    };
  }

  private static buildWorkspaceBlock(workspacePath: string | null): PromptBlock {
    const sections: string[] = [];
    if (workspacePath === null) {
      sections.push('Workspace: not selected.');
      sections.push('Default command cwd: unavailable; ask user to select workspace before local command operations.');
    } else {
      sections.push(`Workspace: ${workspacePath}`);
      sections.push('DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.');
      sections.push('Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.');
      sections.push('Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.');
      sections.push('Never pass /workspace/... to run_shell_command; use a relative path from the default cwd or a real Windows path.');
      sections.push('Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, or grep.');
      sections.push('After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.');
    }
    const content = sections.join('\n');
    return {
      type: 'workspace',
      content,
      stability: BlockStability.WORKSPACE,
      hash: SystemPromptBuilder.computeHash(content)
    };
  }

  private static buildToolsBlock(tools: ClientTool[]): PromptBlock {
    if (tools.length === 0) {
      const content = 'Available Tools: none';
      return {
        type: 'tools',
        content,
        stability: BlockStability.CAPABILITY,
        hash: SystemPromptBuilder.computeHash(content)
      };
    }
    const descriptions = tools
      .map(tool => `- ${tool.name}: ${tool.description}`)
      .join('\n');
    const content = `Available Tools:\n${descriptions}`;
    return {
      type: 'tools',
      content,
      stability: BlockStability.CAPABILITY,
      hash: SystemPromptBuilder.computeHash(content)
    };
  }

  private static buildCapabilityBlock(
    capabilities: ChatStartRunRequest['enabledCapabilities'],
    hint: WorkflowHint
  ): PromptBlock {
    const sections = [`Capabilities: ${createCapabilitySummary(capabilities)}`];
    sections.push(...SystemPromptBuilder.createWorkflowOverview(hint));
    const content = sections.join('\n');
    return {
      type: 'capability',
      content,
      stability: BlockStability.CAPABILITY,
      hash: SystemPromptBuilder.computeHash(content)
    };
  }

  private static createWorkflowOverview(workflowHint: WorkflowHint): string[] {
    if (workflowHint === 'propose_background_task') {
      return [...BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW];
    }
    if (workflowHint === 'background_task_change') {
      return [
        '',
        '本轮工作流：修改已有后台任务。',
        '可用工具：read_background_task / update_background_task / cancel_background_task。',
        'update / cancel 会触发用户审批；read 用于先看清楚再改。',
        '如果缺少 taskId、当前状态或触发规则，先调用 read_background_task；信息已经明确时可以直接 update 或 cancel。',
        'update patch 只包含用户明确要求改变的字段；不要猜测未提及配置。'
      ];
    }
    return [];
  }

  private static computeHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  }
}
