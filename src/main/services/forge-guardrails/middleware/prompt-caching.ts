import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { ProviderType } from '../../../../shared/types';
import type { PromptBlock } from '../../deep-agent/prompt-builder';

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
