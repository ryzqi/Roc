import { AIMessage, HumanMessage, RemoveMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createRescueParsingMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/rescue-parsing';

async function runAfterModel(messages: unknown[]) {
  const middleware = createRescueParsingMiddleware({ availableTools: () => ['get_weather'] });
  if (typeof middleware.afterModel !== 'function') {
    throw new Error('Expected rescue parsing middleware to expose afterModel.');
  }
  return middleware.afterModel({ messages } as never, {} as never);
}

describe('ForgeRescueParsingMiddleware', () => {
  it('rescues Mistral bracket tool calls into structured AIMessage tool_calls', async () => {
    const last = new AIMessage({
      id: 'ai-mistral',
      content: '[TOOL_CALLS]get_weather{"city":"NYC"}'
    });

    const update = await runAfterModel([new HumanMessage('weather'), last]);

    expect(update?.messages).toHaveLength(2);
    expect(update?.messages?.[0]).toBeInstanceOf(RemoveMessage);
    const rebuilt = update?.messages?.[1] as AIMessage;
    expect(rebuilt.id).toBe('ai-mistral');
    expect(rebuilt.content).toBe('');
    expect(rebuilt.tool_calls).toEqual([
      {
        name: 'get_weather',
        args: { city: 'NYC' },
        id: 'call_rescued_ai-mistral_0',
        type: 'tool_call'
      }
    ]);
    expect(rebuilt.additional_kwargs.forge_rescue).toEqual({ strategy: 'mistral_bracket' });
  });

  it('does not change plain text that cannot be rescued', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-plain',
        content: 'Hello, just chatting'
      })
    ]);

    expect(update).toBeUndefined();
  });

  it('does not change an AIMessage that already has structured tool calls', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-existing',
        content: '',
        tool_calls: [
          {
            name: 'get_weather',
            args: { city: 'Paris' },
            id: 'call-existing',
            type: 'tool_call'
          }
        ]
      })
    ]);

    expect(update).toBeUndefined();
  });

  it('preserves stripped think text on the rebuilt AIMessage', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-thinking',
        content: '<think>thinking</think>{"tool":"get_weather","args":{"city":"X"}}'
      })
    ]);

    const rebuilt = update?.messages?.[1] as AIMessage;
    expect(rebuilt.tool_calls?.[0]).toMatchObject({
      name: 'get_weather',
      args: { city: 'X' }
    });
    expect(rebuilt.additional_kwargs.forge_reasoning_text).toBe('thinking');
  });

  it('rescues bare argument JSON through schema-validated candidates', async () => {
    const middleware = createRescueParsingMiddleware({
      availableTools: () => [
        {
          name: 'internet_search',
          acceptsBareArgs: (args) => typeof args.query === 'string'
        }
      ]
    });
    if (typeof middleware.afterModel !== 'function') {
      throw new Error('Expected rescue parsing middleware to expose afterModel.');
    }

    const update = await middleware.afterModel(
      {
        messages: [
          new AIMessage({
            id: 'ai-bare-args',
            content: '{"query":"agnes"}'
          })
        ]
      } as never,
      {} as never
    );

    const rebuilt = update?.messages?.[1] as AIMessage;
    expect(rebuilt.tool_calls).toEqual([
      {
        name: 'internet_search',
        args: { query: 'agnes' },
        id: 'call_rescued_ai-bare-args_0',
        type: 'tool_call'
      }
    ]);
    expect(rebuilt.additional_kwargs.forge_rescue).toEqual({ strategy: 'bare_args_json' });
  });

  it('rescues tool-call shaped content blocks into structured tool calls', async () => {
    const middleware = createRescueParsingMiddleware({ availableTools: () => ['internet_search'] });
    if (typeof middleware.afterModel !== 'function') {
      throw new Error('Expected rescue parsing middleware to expose afterModel.');
    }

    const update = await middleware.afterModel(
      {
        messages: [
          new AIMessage({
            id: 'ai-content-block-tool',
            content: [
              {
                type: 'text',
                text: '\n\n',
                id: 'call-agnes-content-block',
                name: 'internet_search',
                args: '{"query":"agnes"}'
              }
            ]
          })
        ]
      } as never,
      {} as never
    );

    const rebuilt = update?.messages?.[1] as AIMessage;
    expect(rebuilt.tool_calls).toEqual([
      {
        name: 'internet_search',
        args: { query: 'agnes' },
        id: 'call-agnes-content-block',
        type: 'tool_call'
      }
    ]);
    expect(rebuilt.additional_kwargs.forge_rescue).toEqual({ strategy: 'content_block_tool' });
  });
});
