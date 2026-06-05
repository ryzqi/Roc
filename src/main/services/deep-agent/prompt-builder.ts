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
    return { type: 'static', content: '', stability: BlockStability.STATIC, hash: '' };
  }

  private buildWorkspaceBlock(path: string | null): PromptBlock {
    return { type: 'workspace', content: '', stability: BlockStability.WORKSPACE, hash: '' };
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
