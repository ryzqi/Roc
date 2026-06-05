import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { LangChainAgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import type {
  LangChainChatModelHandle,
  LangChainModelFactory
} from '../../../../src/main/services/langchain-model-factory';

describe('LangChainAgentModelFactoryAdapter', () => {
  it('reads final text from LangChain content blocks with NVIDIA reasoning blocks', async () => {
    const adapter = createAdapter(
      new AIMessage({
        content: [
          {
            type: 'reasoning',
            reasoning: 'thinking trace'
          },
          {
            type: 'text',
            text: 'Final answer.'
          }
        ] as never
      })
    );

    const handle = await adapter.createDefaultModelHandle();

    await expect(handle.invoke('prompt')).resolves.toBe('Final answer.');
  });

  it.each([
    {
      name: 'reasoning only',
      response: new AIMessage({
        content: [
          {
            type: 'reasoning',
            reasoning: 'thinking trace'
          }
        ] as never
      }),
      code: 'agent_model_response_empty'
    },
    {
      name: 'unknown block',
      response: new AIMessage({
        content: [
          {
            type: 'image',
            image_url: 'https://example.test/image.png'
          }
        ] as never
      }),
      code: 'agent_model_response_invalid'
    },
    {
      name: 'empty text block',
      response: new AIMessage({
        content: [
          {
            type: 'text',
            text: '   '
          }
        ] as never
      }),
      code: 'agent_model_response_empty'
    },
    {
      name: 'missing content',
      response: {
        role: 'assistant'
      },
      code: 'agent_model_response_invalid'
    }
  ])('keeps $name model responses failed', async ({ code, response }) => {
    const adapter = createAdapter(response);
    const handle = await adapter.createDefaultModelHandle();

    await expect(handle.invoke('prompt')).rejects.toThrow(code);
  });
});

function createAdapter(response: unknown): LangChainAgentModelFactoryAdapter {
  const handle = {
    provider: {
      id: 'nvidia',
      type: 'nvidia'
    },
    modelId: 'nvidia:test-model',
    model: {
      invoke: async () => response
    },
    runtime: {
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      contextBudgetTokens: 128_000,
      modelKwargs: {},
      providerType: 'nvidia',
      streaming: true
    }
  } as unknown as LangChainChatModelHandle;
  const factory = {
    createChatModelByModelId: async () => handle,
    createDefaultChatModel: async () => handle
  } satisfies Pick<LangChainModelFactory, 'createChatModelByModelId' | 'createDefaultChatModel'>;
  return new LangChainAgentModelFactoryAdapter(factory);
}
