import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { ProviderType } from '../../../../shared/types';
import type { PromptBlock } from '../../deep-agent/prompt-builder';
import { BlockStability } from '../../deep-agent/prompt-builder';

export type PromptCachingStrategy = 'aggressive' | 'balanced' | 'conservative' | 'disabled';

export interface PromptCachingOptions {
  enabled?: boolean;
  strategy?: PromptCachingStrategy;
  providerType: ProviderType;
}

export interface CacheSavings {
  percentSaved: number;
  tokensSaved: number;
}

export interface CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[];
  applyCacheControl(message: SystemMessage, breakpoints: number[]): SystemMessage;
  estimateSavings(blocks: PromptBlock[], usage: any): CacheSavings;
}

class AnthropicStrategy implements CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[] {
    switch (strategy) {
      case 'aggressive':
        // 所有块都缓存
        return blocks.map((_, i) => i);

      case 'balanced':
        // 缓存 STATIC / WORKSPACE / CAPABILITY / SESSION，跳过 REQUEST
        return blocks
          .map((block, i) => ({ block, i }))
          .filter(({ block }) => block.stability !== BlockStability.REQUEST)
          .map(({ i }) => i);

      case 'conservative':
        // 仅缓存 STATIC
        return blocks
          .map((block, i) => ({ block, i }))
          .filter(({ block }) => block.stability === BlockStability.STATIC)
          .map(({ i }) => i);

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

  estimateSavings(blocks: PromptBlock[], usage: any): CacheSavings {
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

