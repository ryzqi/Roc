import { createHash } from 'node:crypto';
import type { ChatStartRunRequest, WorkflowHint } from '../../../shared/types';
import type { ClientTool } from '@langchain/core/tools';
import type { FrozenSnapshot } from '../memory/snapshot';
import type { RocPaths } from '../../paths';
import type { WorkspaceService } from '../workspace-service';
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

export class SystemPromptBuilder {
  constructor(
    private readonly paths: RocPaths,
    private readonly workspaceService: WorkspaceService
  ) {}

  build(input: {
    enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
    workspacePath: string | null;
    frozenSnapshot: FrozenSnapshot;
    workflowHint: WorkflowHint;
    tools: ClientTool[];
  }): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    blocks.push(this.buildStaticBlock());
    blocks.push(this.buildWorkspaceBlock(input.workspacePath));
    blocks.push(this.buildToolsBlock(input.tools));
    blocks.push(this.buildSnapshotBlock(input.frozenSnapshot));
    blocks.push(this.buildCapabilityBlock(input.enabledCapabilities, input.workflowHint));
    return blocks;
  }

  private buildStaticBlock(): PromptBlock {
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
      hash: this.computeHash(ROC_STATIC_SYSTEM_PROMPT)
    };
  }

  private buildWorkspaceBlock(workspacePath: string | null): PromptBlock {
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
      hash: this.computeHash(content)
    };
  }

  private buildToolsBlock(tools: ClientTool[]): PromptBlock {
    return { type: 'tools', content: '', stability: BlockStability.CAPABILITY, hash: '' };
  }

  private buildSnapshotBlock(snapshot: FrozenSnapshot): PromptBlock {
    return { type: 'snapshot', content: '', stability: BlockStability.SESSION, hash: '' };
  }

  private buildCapabilityBlock(
    capabilities: ChatStartRunRequest['enabledCapabilities'],
    hint: WorkflowHint
  ): PromptBlock {
    return { type: 'capability', content: '', stability: BlockStability.CAPABILITY, hash: '' };
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  }
}
