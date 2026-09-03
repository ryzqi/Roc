import type {
  ChatTranscriptActivityBlock,
  ChatTranscriptSubagentBlock
} from './chat-transcript';

/**
 * Subagent 块过滤策略
 *
 * 封装 "是否过滤某个 block" 的判断规则
 */
export interface TaskToolFilterPolicy {
  /**
   * 判断是否应该过滤某个 subagent 内部的 block
   *
   * @param block - 待判断的 block
   * @param context - 上下文信息 (是否有子节点)
   * @returns true 表示应该过滤掉该 block
   */
  shouldFilter(block: ChatTranscriptSubagentBlock, context: { hasChildren: boolean }): boolean;
}

/**
 * 默认过滤策略
 *
 * 规则:
 * - 有子节点时不过滤 (保留所有 blocks)
 * - 无子节点时过滤 task 工具调用 (kind === 'tool_call' && name === 'task')
 */
export class DefaultTaskToolFilterPolicy implements TaskToolFilterPolicy {
  shouldFilter(block: ChatTranscriptSubagentBlock, context: { hasChildren: boolean }): boolean {
    if (context.hasChildren) {
      return false;
    }
    return block.kind === 'tool_call' && block.name === 'task';
  }
}

type ChatTranscriptSubagentActivityBlock = Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;

/**
 * Subagent 块树
 *
 * 封装 subagent 递归结构的遍历和过滤逻辑
 */
export class SubagentBlockTree {
  /**
   * 过滤 activity blocks 中的 task 工具调用
   *
   * 主入口: 处理顶层 ChatTranscriptActivityBlock[], 递归规范化所有 subagent 块
   *
   * @param blocks - 顶层 activity blocks (可能包含 subagent 和其他类型)
   * @param policy - 过滤策略 (可选, 默认使用 DefaultTaskToolFilterPolicy)
   * @returns 过滤后的 blocks (不可变更新)
   */
  static filterTaskToolsFromActivityBlocks(
    blocks: readonly ChatTranscriptActivityBlock[],
    policy?: TaskToolFilterPolicy
  ): readonly ChatTranscriptActivityBlock[] {
    const effectivePolicy = policy ?? new DefaultTaskToolFilterPolicy();

    // 1. 规范化所有 subagent blocks
    let changed = false;
    const normalizedBlocks = blocks.map((block) => {
      if (block.kind !== 'subagent') {
        return block;
      }
      const nextBlock = SubagentBlockTree.normalizeSubagent(block, effectivePolicy);
      if (nextBlock !== block) {
        changed = true;
      }
      return nextBlock;
    });

    // 2. 如果有 subagent blocks, 顶层也过滤 task 工具
    if (!normalizedBlocks.some((block) => block.kind === 'subagent')) {
      return changed ? normalizedBlocks : blocks;
    }

    const nextBlocks = normalizedBlocks.filter(
      (block) => !(block.kind === 'tool_call' && block.name === 'task')
    );
    return changed || nextBlocks.length !== blocks.length ? nextBlocks : blocks;
  }

  /**
   * 规范化单个 subagent block (递归)
   *
   * @param block - subagent block
   * @param policy - 过滤策略
   * @returns 规范化后的 block (不可变更新)
   */
  private static normalizeSubagent(
    block: ChatTranscriptSubagentActivityBlock,
    policy: TaskToolFilterPolicy
  ): ChatTranscriptSubagentActivityBlock {
    // 递归处理 children
    const children = block.children.map((child) => SubagentBlockTree.normalizeSubagent(child, policy));
    const hasChildChange = children.some((child, index) => child !== block.children[index]);

    // 应用过滤策略
    const hasChildren = block.children.length > 0;
    const blocks = block.blocks.filter((b) => !policy.shouldFilter(b, { hasChildren }));

    if (!hasChildChange && blocks.length === block.blocks.length) {
      return block;
    }

    return {
      ...block,
      blocks,
      children
    };
  }
}
