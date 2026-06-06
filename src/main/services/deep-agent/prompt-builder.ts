import { createHash } from 'node:crypto';
import type { ChatStartRunRequest, WorkflowHint } from '../../../shared/types';
import type { ClientTool } from '@langchain/core/tools';
import type { FrozenSnapshot } from '../memory/snapshot';
import { createCapabilitySummary } from './prompt';

/**
 * 提示块稳定性级别，决定缓存失效边界
 */
export enum BlockStability {
  STATIC = 'static',           // 跨所有会话不变
  WORKSPACE = 'workspace',     // 工作区级稳定
  SESSION = 'session',         // 会话级稳定
  CAPABILITY = 'capability',   // 能力集变化时失效
  REQUEST = 'request'          // 每请求重建
}

/**
 * 系统提示的可缓存块
 */
export interface PromptBlock {
  type: 'static' | 'workspace' | 'tools' | 'snapshot' | 'capability';
  content: string;
  stability: BlockStability;
  hash: string;  // SHA-256 前 16 字符
  metadata?: {
    tokenEstimate?: number;
    lastModified?: string;
  };
}

/**
 * 缓存节省指标
 */
export interface CacheSavings {
  percentSaved: number;  // 0-100
  tokensSaved: number;
}

/**
 * 构建分层的系统提示块
 * 纯函数，无状态依赖
 */
export class SystemPromptBuilder {

  static build(input: {
    enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
    workspacePath: string | null;
    frozenSnapshot: FrozenSnapshot;
    workflowHint: WorkflowHint;
    tools: ClientTool[];
  }): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    blocks.push(SystemPromptBuilder.buildStaticBlock());
    blocks.push(SystemPromptBuilder.buildWorkspaceBlock(input.workspacePath));
    blocks.push(SystemPromptBuilder.buildToolsBlock(input.tools));
    blocks.push(SystemPromptBuilder.buildSnapshotBlock(input.frozenSnapshot));
    blocks.push(SystemPromptBuilder.buildCapabilityBlock(input.enabledCapabilities, input.workflowHint));
    return blocks;
  }

  private static buildStaticBlock(): PromptBlock {
    const ROC_STATIC_SYSTEM_PROMPT = [
      'You are Roc, a long-running personal assistant on Windows. Be concise; claim only inspected evidence.',
      '',
      'Persistent memory you can edit (changes land on disk immediately, visible in next session):',
      '  /memory/global/USER.md      — user identity, preferences, comm style (~500 tok cap)',
      '  /memory/global/AGENTS.md    — global default rules (~300 tok cap)',
      '  /memory/global/MEMORY.md    — global long-term facts (~800 tok cap)',
      '  /memory/workspaces/current/AGENTS.md   — workspace-specific rules (overrides global if exists)',
      '  /memory/workspaces/current/MEMORY.md   — workspace-specific facts (overrides global if exists)',
      '',
      'Use Edit/Write on those paths. On capacity overflow you receive "X/Y, please consolidate" — read the file, merge/drop redundant entries via Edit, then retry.',
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
      sections.push('Default cwd: unavailable; ask user to select workspace before file or shell ops.');
    } else {
      sections.push(`Workspace: ${workspacePath}`);
      sections.push('Default cwd: selected Roc workspace root; use /workspace/ for Deep Agents file tools.');
      sections.push('For Deep Agents file tools, current directory means /workspace/.');
      sections.push('Do not pass Windows absolute paths like C:\\path\\file.txt or G:\\path\\file.txt to read_file, write_file, or edit_file.');
      sections.push('After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.');
      sections.push('Run file and shell ops inside workspace unless user explicitly names another allowed path.');
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

  private static buildSnapshotBlock(snapshot: FrozenSnapshot): PromptBlock {
    const { renderFrozenSnapshotWithPercentage } = require('../memory/snapshot');
    const content = renderFrozenSnapshotWithPercentage(snapshot);
    return {
      type: 'snapshot',
      content,
      stability: BlockStability.SESSION,
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
      return [
        '',
        '本轮工作流：创建后台任务。',
        '可用工具：resolve_background_task_time / propose_background_task / schedule_background_task / confirm_with_user。',
        '先调用 resolve_background_task_time 解析触发时间。',
        '用返回的 trigger 组装 propose_background_task。',
        'propose 仅生成草稿；schedule 才实际落地；confirm 通知用户工作完成或请求用户补充缺失时间。',
        'One-shot：用户说"每天 9:00 检查测试失败情况"时，依次调用：',
        '1. resolve_background_task_time({ text: "每天 9:00 检查测试失败情况" })',
        '2. propose_background_task({ goal, trigger: resolved.trigger, workspacePath })',
        '3. schedule_background_task({ previewId })',
        '4. confirm_with_user({ summary })'
      ];
    }
    if (workflowHint === 'background_task_change') {
      return [
        '',
        '本轮工作流：修改已有后台任务。',
        '可用工具：read_background_task / update_background_task / cancel_background_task。',
        'update / cancel 会触发用户审批；read 用于先看清楚再改。'
      ];
    }
    return [];
  }

  private static computeHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  }
}
