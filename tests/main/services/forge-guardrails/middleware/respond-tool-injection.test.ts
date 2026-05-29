import { AIMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  readForgeMessageTag,
  RESPOND_TOOL_NAME
} from '../../../../../src/main/services/forge-guardrails';
import { createRespondToolInjectionMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/respond-tool-injection';

function fakeTool(name: string): ClientTool {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({}),
    invoke: vi.fn()
  } as unknown as ClientTool;
}

async function runWrapModelCall(input: {
  enabled: boolean;
  tools?: ClientTool[];
  response: AIMessage;
}) {
  const middleware = createRespondToolInjectionMiddleware({ enabled: input.enabled });
  if (typeof middleware.wrapModelCall !== 'function') {
    throw new Error('Expected respond tool injection middleware to expose wrapModelCall.');
  }
  const captured: { handlerTools: ClientTool[] | null } = { handlerTools: null };
  const request = {
    tools: input.tools === undefined ? [] : input.tools
  } as never;
  const response = await middleware.wrapModelCall(request, async (nextRequest) => {
    captured.handlerTools = nextRequest.tools as ClientTool[];
    return input.response;
  });
  return { response, handlerTools: captured.handlerTools };
}

describe('ForgeRespondToolInjection', () => {
  it('injects respond and converts a respond tool call into visible AIMessage content', async () => {
    const { response, handlerTools } = await runWrapModelCall({
      enabled: true,
      tools: [fakeTool('get_weather')],
      response: new AIMessage({
        id: 'ai-respond',
        content: '',
        tool_calls: [
          {
            name: RESPOND_TOOL_NAME,
            args: { message: '你好' },
            id: 'call-respond',
            type: 'tool_call'
          }
        ]
      })
    });

    expect(handlerTools?.map((tool) => tool.name)).toEqual(['get_weather', RESPOND_TOOL_NAME]);
    expect(response).toBeInstanceOf(AIMessage);
    const message = response as AIMessage;
    expect(message.content).toBe('你好');
    expect(message.tool_calls).toEqual([]);
    expect(readForgeMessageTag(message)).toBe('forge:respond_synthetic');
  });

  it('keeps ordinary tool calls unchanged after injecting respond into the request', async () => {
    const modelResponse = new AIMessage({
      id: 'ai-tool',
      content: '',
      tool_calls: [
        {
          name: 'get_weather',
          args: { city: 'Paris' },
          id: 'call-weather',
          type: 'tool_call'
        }
      ]
    });

    const { response, handlerTools } = await runWrapModelCall({
      enabled: true,
      tools: [fakeTool('get_weather')],
      response: modelResponse
    });

    expect(handlerTools?.map((tool) => tool.name)).toEqual(['get_weather', RESPOND_TOOL_NAME]);
    expect(response).toBe(modelResponse);
  });

  it('uses the first respond call and warns when multiple respond calls are returned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { response } = await runWrapModelCall({
      enabled: true,
      response: new AIMessage({
        id: 'ai-multi',
        content: '',
        tool_calls: [
          {
            name: RESPOND_TOOL_NAME,
            args: { message: 'A' },
            id: 'call-a',
            type: 'tool_call'
          },
          {
            name: RESPOND_TOOL_NAME,
            args: { message: 'B' },
            id: 'call-b',
            type: 'tool_call'
          }
        ]
      })
    });

    expect((response as AIMessage).content).toBe('A');
    expect(warn).toHaveBeenCalledWith('[ForgeRespondToolInjection] Multiple respond calls in one AIMessage; using first.');
  });

  it('strips respond while preserving other tool calls', async () => {
    const { response } = await runWrapModelCall({
      enabled: true,
      response: new AIMessage({
        id: 'ai-mixed',
        content: '',
        tool_calls: [
          {
            name: RESPOND_TOOL_NAME,
            args: { message: 'Hi' },
            id: 'call-respond',
            type: 'tool_call'
          },
          {
            name: 'get_weather',
            args: { city: 'NYC' },
            id: 'call-weather',
            type: 'tool_call'
          }
        ]
      })
    });

    const message = response as AIMessage;
    expect(message.content).toBe('Hi');
    expect(message.tool_calls).toEqual([
      {
        name: 'get_weather',
        args: { city: 'NYC' },
        id: 'call-weather',
        type: 'tool_call'
      }
    ]);
  });

  it('does not inject respond or transform the response when disabled', async () => {
    const modelResponse = new AIMessage({
      id: 'ai-disabled',
      content: 'Hello',
      tool_calls: [
        {
          name: RESPOND_TOOL_NAME,
          args: { message: 'ignored' },
          id: 'call-respond',
          type: 'tool_call'
        }
      ]
    });

    const { response, handlerTools } = await runWrapModelCall({
      enabled: false,
      tools: [fakeTool('get_weather')],
      response: modelResponse
    });

    expect(handlerTools?.map((tool) => tool.name)).toEqual(['get_weather']);
    expect(response).toBe(modelResponse);
  });
});
