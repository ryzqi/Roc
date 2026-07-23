import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createContextTokenCounter,
  deriveContextBudgetProfile
} from '../../../../../src/main/services/deep-agent/context/context-token-budget';

describe('context token budget', () => {
  it('uses the model token counter and derives separate budget components', async () => {
    const getNumTokens = vi.fn(async (content: unknown) => Math.ceil(String(content).length / 5));
    const counter = createContextTokenCounter({ getNumTokens } as never);

    const profile = await deriveContextBudgetProfile({
      contextWindowTokens: 8192,
      counter,
      systemPrompt: 'system instructions',
      tools: [{ name: 'read_file', description: 'Read a workspace file.', schema: z.object({ path: z.string() }) }]
    });
    const count = await counter.countMessages([new HumanMessage('hello')]);

    expect(getNumTokens).toHaveBeenCalled();
    expect(count.estimated).toBe(false);
    expect(counter.wasEstimated()).toBe(false);
    expect(profile.contextWindowTokens).toBe(8192);
    expect(profile.modelInputTokens).toBe(
      profile.contextWindowTokens -
      profile.reservedOutputTokens -
      profile.systemToolOverheadTokens -
      profile.safetyMarginTokens
    );
    expect(profile.summaryInputTokens).toBeLessThan(profile.modelInputTokens);
  });

  it('counts AI tool-call arguments and tool schemas in the hard-budget inputs', async () => {
    const getNumTokens = vi.fn(async (content: unknown) => String(content).length);
    const counter = createContextTokenCounter({ getNumTokens } as never);
    const toolCall = new AIMessage({
      content: '',
      tool_calls: [{
        id: 'call-large',
        name: 'read_file',
        args: { path: 'x'.repeat(500) },
        type: 'tool_call'
      }]
    });

    const count = await counter.countMessages([toolCall]);
    const withoutToolCall = await counter.countMessages([new AIMessage({ content: '' })]);
    expect(count.tokens).toBeGreaterThan(withoutToolCall.tokens + 500);
    const toolResult = await counter.countMessages([new ToolMessage({
      content: '',
      name: 'read_file_' + 'x'.repeat(500),
      status: 'success',
      tool_call_id: 'call-large'
    })]);
    const withoutToolMetadata = await counter.countMessages([new HumanMessage('')]);
    expect(toolResult.tokens).toBeGreaterThan(withoutToolMetadata.tokens + 500);

    const plainProfile = await deriveContextBudgetProfile({
      contextWindowTokens: 8192,
      counter,
      systemPrompt: 'system instructions',
      tools: [{ name: 'read_file', description: 'Read a workspace file.' }]
    });
    const schemaProfile = await deriveContextBudgetProfile({
      contextWindowTokens: 8192,
      counter,
      systemPrompt: 'system instructions',
      tools: [{
        name: 'read_file',
        description: 'Read a workspace file.',
        schema: z.object({ payload: z.string().describe('x'.repeat(1000)) })
      }]
    });
    expect(schemaProfile.systemToolOverheadTokens).toBeGreaterThan(plainProfile.systemToolOverheadTokens);
  });

  it('falls back to a conservative estimate and records estimated usage', async () => {
    const counter = createContextTokenCounter({
      getNumTokens: async () => {
        throw new Error('tokenizer_unavailable');
      }
    } as never);

    const count = await counter.countMessages([
      new HumanMessage('必须保守估算这个上下文。')
    ]);
    const highEntropyAscii = ('A+/9').repeat(250);
    const textCount = await counter.countText(highEntropyAscii);

    expect(count.estimated).toBe(true);
    expect(count.tokens).toBeGreaterThan(8);
    expect(textCount.tokens).toBeGreaterThanOrEqual(Buffer.byteLength(highEntropyAscii, 'utf8'));
    expect(counter.wasEstimated()).toBe(true);
  });

  it('rejects a zero token count for non-empty text and uses the conservative fallback', async () => {
    const counter = createContextTokenCounter({
      getNumTokens: async () => 0
    } as never);

    const count = await counter.countText('non-empty');

    expect(count).toEqual({
      estimated: true,
      tokens: Buffer.byteLength('non-empty', 'utf8')
    });
    expect(counter.wasEstimated()).toBe(true);
  });

  it('rejects a context window that cannot fit reserved and overhead budgets', async () => {
    const counter = createContextTokenCounter({
      getNumTokens: async () => 1000
    } as never);

    await expect(deriveContextBudgetProfile({
      contextWindowTokens: 512,
      counter,
      systemPrompt: 'system',
      tools: []
    })).rejects.toThrow('context_budget_profile_invalid');
  });
});
