import { describe, it, expect } from 'vitest';
import {
  AnthropicStrategy,
  OpenAIStrategy,
  CacheStrategyFactory
} from '../../../../../src/main/services/forge-guardrails/middleware/prompt-caching';
import { BlockStability } from '../../../../../src/main/services/deep-agent/prompt-builder';
import type { PromptBlock } from '../../../../../src/main/services/deep-agent/prompt-builder';

describe('AnthropicStrategy', () => {
  const strategy = new AnthropicStrategy();

  const mockBlocks: PromptBlock[] = [
    { type: 'static', content: 'static', stability: BlockStability.STATIC, hash: 'a' },
    { type: 'workspace', content: 'workspace', stability: BlockStability.WORKSPACE, hash: 'b' },
    { type: 'tools', content: 'tools', stability: BlockStability.CAPABILITY, hash: 'c' },
    { type: 'capability', content: 'request', stability: BlockStability.REQUEST, hash: 'd' }
  ];

  it('aggressive 模式应标记所有块', () => {
    const breakpoints = strategy.detectBreakpoints(mockBlocks, 'aggressive');
    expect(breakpoints).toEqual([0, 1, 2, 3]);
  });

  it('balanced 模式应跳过 REQUEST', () => {
    const breakpoints = strategy.detectBreakpoints(mockBlocks, 'balanced');
    expect(breakpoints).toEqual([0, 1, 2]);
    expect(breakpoints).not.toContain(3);
  });

  it('conservative 模式应仅标记 STATIC', () => {
    const breakpoints = strategy.detectBreakpoints(mockBlocks, 'conservative');
    expect(breakpoints).toEqual([0]);
  });
});

describe('CacheStrategyFactory', () => {
  it('应为 anthropic 返回 AnthropicStrategy', () => {
    const strategy = CacheStrategyFactory.create('anthropic_compatible');
    expect(strategy).toBeInstanceOf(AnthropicStrategy);
  });

  it('应为 openai 返回 OpenAIStrategy', () => {
    const strategy = CacheStrategyFactory.create('openai_compatible');
    expect(strategy).toBeInstanceOf(OpenAIStrategy);
  });
});
