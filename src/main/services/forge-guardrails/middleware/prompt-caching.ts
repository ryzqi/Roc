import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { ProviderType } from '../../../../shared/types';
import type { PromptBlock } from '../../deep-agent/context/prompt-blocks';
import { BlockStability } from '../../deep-agent/context/prompt-blocks';

type PromptCachingStrategy = 'aggressive' | 'balanced' | 'conservative' | 'disabled';

export interface PromptCachingOptions {
  enabled?: boolean;
  strategy?: PromptCachingStrategy;
  providerType: ProviderType;
}

interface CacheSavings {
  percentSaved: number;
  tokensSaved: number;
}

export const MAX_ANTHROPIC_CACHE_CONTROL_MARKERS = 4;

const BALANCED_PRIORITY: ReadonlyArray<PromptBlock['type']> = [
  'static',
  'workspace',
  'capability',
  'context_recall',
  'tools'
];

export interface CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[];
  applyCacheControl(message: SystemMessage, breakpoints: number[]): SystemMessage;
  estimateSavings(blocks: PromptBlock[], usage: any): CacheSavings;
}

class AnthropicStrategy implements CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[] {
    switch (strategy) {
      case 'aggressive':
        return capBreakpoints(
          blocks
            .map((block, index) => ({ block, index }))
            .filter(({ block }) => block.stability !== BlockStability.REQUEST)
            .map(({ index }) => index)
        );

      case 'balanced':
        return capBreakpoints(indexesByTypePriority(blocks, BALANCED_PRIORITY));

      case 'conservative':
        return capBreakpoints(indexesForStability(blocks, BlockStability.STATIC));

      default:
        return [];
    }
  }

  applyCacheControl(message: SystemMessage, breakpoints: number[]): SystemMessage {
    const content = message.content;
    if (typeof content === 'string') {
      // 降级：字符串内容无法标记多个断点
      return message;
    }

    const contentArray = Array.isArray(content) ? content : [content];
    const enhanced = contentArray.map((block, index) => {
      if (typeof block === 'string') {
        return block;
      }
      return {
        ...block,
        ...(breakpoints.includes(index) && {
          cache_control: { type: 'ephemeral' as const }
        })
      };
    });

    return new SystemMessage({ content: enhanced });
  }

  estimateSavings(_blocks: PromptBlock[], usage: any): CacheSavings {
    const cacheReadTokens = usage?.input_token_details?.cache_read || 0;
    const totalPromptTokens = usage?.input_tokens || 0;

    if (totalPromptTokens === 0) {
      return { percentSaved: 0, tokensSaved: 0 };
    }

    // Anthropic: 缓存命中 token 降至 10%，节省 90%
    const tokensSaved = Math.floor(cacheReadTokens * 0.9);
    const percentSaved = (tokensSaved / totalPromptTokens) * 100;

    return { percentSaved, tokensSaved };
  }
}

function capBreakpoints(indexes: number[]): number[] {
  return indexes.slice(0, MAX_ANTHROPIC_CACHE_CONTROL_MARKERS).sort((left, right) => left - right);
}

function indexesForStability(blocks: PromptBlock[], stability: BlockStability): number[] {
  return blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.stability === stability)
    .map(({ index }) => index);
}

function indexesByTypePriority(blocks: PromptBlock[], priority: ReadonlyArray<PromptBlock['type']>): number[] {
  const selected: number[] = [];
  for (const type of priority) {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block !== undefined && block.type === type && block.stability !== BlockStability.REQUEST) {
        selected.push(index);
      }
    }
  }
  return selected;
}

class OpenAIStrategy implements CacheStrategy {
  detectBreakpoints(_blocks: PromptBlock[], _strategy: PromptCachingStrategy): number[] {
    // OpenAI 自动缓存前缀，无需标记
    return [];
  }

  applyCacheControl(message: SystemMessage, _breakpoints: number[]): SystemMessage {
    // OpenAI 不注入 cache_control
    return message;
  }

  estimateSavings(blocks: PromptBlock[], usage: any): CacheSavings {
    // OpenAI usage 中没有显式 cache 字段，估算基于前缀长度
    const prefixTokens = this.estimatePrefixTokens(blocks);
    const totalPromptTokens = usage?.input_tokens || 0;

    if (totalPromptTokens === 0) {
      return { percentSaved: 0, tokensSaved: 0 };
    }

    // 假设前缀命中后节省 90%
    const tokensSaved = Math.floor(prefixTokens * 0.9);
    const percentSaved = (tokensSaved / totalPromptTokens) * 100;

    return { percentSaved, tokensSaved };
  }

  private estimatePrefixTokens(blocks: PromptBlock[]): number {
    // 估算稳定前缀的 token 数（粗略：4 字符 ≈ 1 token）
    return blocks
      .filter(b => b.stability !== BlockStability.REQUEST)
      .reduce((sum, b) => sum + Math.ceil(b.content.length / 4), 0);
  }
}

export class CacheStrategyFactory {
  static create(providerType: ProviderType): CacheStrategy {
    switch (providerType) {
      case 'anthropic_compatible':
        return new AnthropicStrategy();
      case 'openai_compatible':
      case 'openrouter':
      case 'nvidia':
      case 'llama_cpp':
        return new OpenAIStrategy();
      default:
        return new OpenAIStrategy();  // 默认
    }
  }
}

export { AnthropicStrategy, OpenAIStrategy };

/**
 * 从带分隔符的字符串中解析 PromptBlock[]
 * 格式：<!-- BLOCK:type:stability:hash -->content
 */
function parseBlocksFromContent(content: string): PromptBlock[] {
  const blockRegex = /<!-- BLOCK:(\w+):(\w+):(\w+) -->\n([\s\S]*?)(?=<!-- BLOCK:|\n*$)/g;
  const blocks: PromptBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(content)) !== null) {
    const [, type, stability, hash, blockContent] = match;
    blocks.push({
      type: type as PromptBlock['type'],
      content: blockContent.trim(),
      stability: stability as BlockStability,
      hash
    });
  }

  return blocks;
}

export function createPromptCachingMiddleware(options: PromptCachingOptions) {
  const { enabled = true, strategy = 'balanced', providerType } = options;

  if (!enabled || strategy === 'disabled') {
    return createMiddleware({
      name: 'PromptCaching',
      wrapModelCall: async (request, handler) => handler(request)
    });
  }

  const cacheStrategy = CacheStrategyFactory.create(providerType);

  return createMiddleware({
    name: 'PromptCaching',
    wrapModelCall: async (request, handler) => {
      try {
        const messages = request.messages as BaseMessage[];
        const systemMsg = messages.find(m => SystemMessage.isInstance(m)) as SystemMessage | undefined;

        if (!systemMsg) {
          if (process.env.DEBUG === 'roc:prompt-caching') {
            console.log('[PromptCaching] No SystemMessage found, skipping cache control injection');
          }
          return handler(request);
        }

        // 仅对 Anthropic 注入 cache_control
        if (providerType !== 'anthropic_compatible') {
          if (process.env.DEBUG === 'roc:prompt-caching') {
            console.log('[PromptCaching] Non-Anthropic provider, skipping (auto prefix caching)');
          }
          return handler(request);
        }

        const content = systemMsg.content;
        if (typeof content !== 'string') {
          // 已经是结构化格式，不处理
          return handler(request);
        }

        // 从分隔符提取 blocks
        const blocks = parseBlocksFromContent(content);
        if (blocks.length === 0) {
          if (process.env.DEBUG === 'roc:prompt-caching') {
            console.log('[PromptCaching] No block markers found, skipping');
          }
          return handler(request);
        }

        // 根据策略决定哪些 block 需要缓存
        const breakpoints = cacheStrategy.detectBreakpoints(blocks, strategy);

        if (process.env.DEBUG === 'roc:prompt-caching') {
          console.log('[PromptCaching] Strategy:', strategy, 'Breakpoints:', breakpoints);
        }

        // 转换为 Anthropic 的结构化 content
        const structuredContent = blocks.map((block, index) => ({
          type: 'text' as const,
          text: block.content,
          ...(breakpoints.includes(index) && { cache_control: { type: 'ephemeral' as const } })
        }));

        // 替换 SystemMessage
        const enhancedMsg = new SystemMessage({ content: structuredContent });
        const msgIndex = messages.indexOf(systemMsg);
        messages[msgIndex] = enhancedMsg;

        return handler(request);
      } catch (error) {
        // 降级：缓存注入失败，继续原始请求
        console.warn('[PromptCaching] Cache control injection failed', error);
        return handler(request);
      }
    }
  });
}
