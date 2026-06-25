import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import {
  BlockStability,
  buildPromptBlocks
} from '../../../../../src/main/services/deep-agent/context/prompt-blocks';
import type { PromptBlock } from '../../../../../src/main/services/deep-agent/context/prompt-blocks';
import { serializePromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-serialization';
import {
  AnthropicStrategy,
  CacheStrategyFactory,
  createPromptCachingMiddleware,
  OpenAIStrategy
} from '../../../../../src/main/services/forge-guardrails/middleware/prompt-caching';

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

describe('createPromptCachingMiddleware', () => {
  it('injects cache_control from a production serialized prompt for Anthropic-compatible providers', async () => {
    const prompt = serializePromptBlocks(
      buildPromptBlocks({
        enabledCapabilities: { mcpServers: [], skills: [] },
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: [{ name: 'session_search', description: 'Search prior conversations' }],
        explicitSkillContexts: []
      })
    );
    const middleware = createPromptCachingMiddleware({
      providerType: 'anthropic_compatible',
      strategy: 'balanced'
    });
    const handler = vi.fn(async request => request);
    const wrapModelCall = middleware.wrapModelCall;
    if (wrapModelCall === undefined) {
      throw new Error('prompt_caching_wrap_model_call_missing');
    }

    await wrapModelCall(
      {
        messages: [new SystemMessage(prompt)]
      } as never,
      handler as never
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const firstCall = handler.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('prompt_caching_handler_not_called');
    }
    const handledRequest = firstCall[0] as { messages: SystemMessage[] };
    const systemMessage = handledRequest.messages[0];
    expect(systemMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          cache_control: { type: 'ephemeral' }
        })
      ])
    );
  });
});
