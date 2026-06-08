import { describe, it, expect } from 'vitest';
import {
  AnthropicStrategy,
  OpenAIStrategy,
  CacheStrategyFactory
} from '../../../../src/main/services/forge-guardrails/middleware/prompt-caching';
import { BlockStability } from '../../../../src/main/services/deep-agent/prompt-builder';
import type { PromptBlock } from '../../../../src/main/services/deep-agent/prompt-builder';

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

  it('disabled 模式应返回空数组', () => {
    const breakpoints = strategy.detectBreakpoints(mockBlocks, 'disabled');
    expect(breakpoints).toEqual([]);
  });

  it('应正确计算 Anthropic 节省（90% 减免）', () => {
    const usage = {
      input_tokens: 1000,
      input_token_details: { cache_read: 500 }
    };
    const savings = strategy.estimateSavings(mockBlocks, usage);
    expect(savings.tokensSaved).toBe(450); // 500 * 0.9
    expect(savings.percentSaved).toBe(45); // 450 / 1000 * 100
  });
});

describe('OpenAIStrategy', () => {
  const strategy = new OpenAIStrategy();

  it('应返回空 breakpoints（自动缓存）', () => {
    const mockBlocks: PromptBlock[] = [
      { type: 'static', content: 'test', stability: BlockStability.STATIC, hash: 'x' }
    ];
    const breakpoints = strategy.detectBreakpoints(mockBlocks, 'balanced');
    expect(breakpoints).toEqual([]);
  });

  it('应估算前缀 token 节省', () => {
    const mockBlocks: PromptBlock[] = [
      { type: 'static', content: 'a'.repeat(400), stability: BlockStability.STATIC, hash: 'x' }, // ~100 tokens
      { type: 'capability', content: 'req', stability: BlockStability.REQUEST, hash: 'y' }
    ];
    const usage = { input_tokens: 200 };
    const savings = strategy.estimateSavings(mockBlocks, usage);
    expect(savings.tokensSaved).toBeGreaterThan(0);
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

  it('应为未知供应商返回默认策略', () => {
    const strategy = CacheStrategyFactory.create('openrouter');
    expect(strategy).toBeInstanceOf(OpenAIStrategy);
  });
});
