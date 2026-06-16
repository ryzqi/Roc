import { createHash } from 'node:crypto';
import type { ChatStartRunRequest, WorkflowHint } from '../../../shared/types';
import type { ClientTool } from '@langchain/core/tools';
import type { FrozenSnapshot } from '../memory/snapshot';
import { renderFrozenSnapshotWithPercentage } from '../memory/snapshot';
import { BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW, createCapabilitySummary } from './prompt';
import { SystemMessage } from '@langchain/core/messages';
import type { PromptCachingStrategy } from '../forge-guardrails/middleware/prompt-caching';

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
      sections.push('Default cwd for shell commands: selected Roc workspace root.');
      sections.push('Use /workspace/ only for Deep Agents file tools.');
      sections.push('Use the Windows workspace root for shell paths; never run rtk ls /workspace.');
      sections.push('For directory listings on native Windows, prefer the file ls tool or PowerShell Get-ChildItem.');
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
      return [...BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW];
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

/**
 * 将 PromptBlock[] 转换为 SystemMessage，根据策略注入 cache_control
 */
export function blocksToSystemMessage(
  blocks: PromptBlock[],
  strategy: PromptCachingStrategy,
  providerType: string
): SystemMessage {
  // 对于 Anthropic，注入 cache_control
  if (providerType === 'anthropic_compatible' && strategy !== 'disabled') {
    const content = blocks.map((block) => {
      const shouldCache = shouldCacheBlock(block.stability, strategy);
      return {
        type: 'text' as const,
        text: block.content,
        ...(shouldCache && { cache_control: { type: 'ephemeral' as const } }),
        // 附加元信息供 Middleware 使用
        __block_metadata: {
          blockType: block.type,
          stability: block.stability,
          hash: block.hash
        }
      };
    });
    return new SystemMessage({ content });
  }

  // 对于 OpenAI 或其他，直接拼接为字符串（自动前缀缓存）
  const content = blocks.map(b => b.content).join('\n\n');
  return new SystemMessage({
    content,
    // 附加 blocks 信息供调试
    additional_kwargs: { __blocks: blocks }
  });
}

/**
 * 根据稳定性和策略判断是否应该缓存
 */
function shouldCacheBlock(stability: BlockStability, strategy: PromptCachingStrategy): boolean {
  switch (strategy) {
    case 'aggressive':
      return true;  // 所有块都缓存

    case 'balanced':
      // 跳过 REQUEST
      return stability !== BlockStability.REQUEST;

    case 'conservative':
      // 仅缓存 STATIC
      return stability === BlockStability.STATIC;

    default:
      return false;
  }
}
