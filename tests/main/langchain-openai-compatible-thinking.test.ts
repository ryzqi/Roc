import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-openai-compatible-thinking-');
});

afterEach(async () => {
  await services.cleanup();
});

describe('OpenAI-compatible thinking with tool calls', () => {
  it('preserves configured chat template thinking when an OpenAI-compatible model binds tools', async () => {
    configureOpenAiCompatibleProvider();
    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<{ chat_template_kwargs?: unknown; tools?: unknown[] }> = [];
    const webSearchSchema = z.object({
      query: z.string()
    });
    const completionModel = (result.model as ChatOpenAI).bindTools([
      tool(async ({ query }: z.infer<typeof webSearchSchema>) => `result:${query}`, {
        name: 'web_search',
        description: 'Search the web.',
        schema: webSearchSchema
      })
    ]) as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
      invoke: (input: unknown) => Promise<unknown>;
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { chat_template_kwargs?: unknown; tools?: unknown[] });
      yield {
        choices: [
          {
            delta: {
              role: 'assistant',
              content: 'OK'
            },
            index: 0,
            finish_reason: 'stop'
          }
        ]
      };
    };

    await completionModel.invoke([new HumanMessage('Search Agnes.')]);

    expect(requests[0]?.tools).toHaveLength(1);
    expect(requests[0]?.chat_template_kwargs).toEqual({
      enable_thinking: true
    });
    expect(result.runtime.modelKwargs).toEqual({
      chat_template_kwargs: {
        enable_thinking: true
      }
    });
  });
});

function configureOpenAiCompatibleProvider(): void {
  services.secretService.setProviderSecret('openai-compatible', 'sk-openai-compatible-test');
  services.configService.saveProviders({
    schemaVersion: 1,
    defaultModelId: 'agnes-2.0-flash',
    providers: [
      {
        id: 'openai-compatible',
        name: 'OpenAI Compatible',
        type: 'openai_compatible',
        endpoint: 'https://apihub.agnes-ai.com/v1',
        credentialRef: 'secret:openai-compatible',
        enabled: true,
        models: [
          {
            id: 'agnes-2.0-flash',
            displayName: 'OpenAI Compatible Thinking Model',
            enabled: true,
            supportsStreaming: true,
            supportsToolCalls: true,
            supportsImages: false
          }
        ],
        options: {
          reasoning: {
            effort: 'xhigh'
          },
          modelKwargs: {
            chat_template_kwargs: {
              enable_thinking: true
            }
          }
        }
      }
    ]
  });
}
