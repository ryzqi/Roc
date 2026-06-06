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

class OpenAIStrategy implements CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[] {
    // OpenAI 自动缓存前缀，无需标记
    return [];
  }

  applyCacheControl(message: SystemMessage, breakpoints: number[]): SystemMessage {
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

