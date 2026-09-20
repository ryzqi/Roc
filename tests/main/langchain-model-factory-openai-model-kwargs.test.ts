import { HumanMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-langchain-model-factory-');
});
afterEach(async () => {
  await services.cleanup();
});



describe('LangChainModelFactory', () => {
  it('passes OpenAI-compatible modelKwargs into ChatOpenAI runtime and requests', async () => {
    services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 2,
      defaultModelId: 'openai-local:qwen-local',
      providers: [
        {
          id: 'openai-local',
          name: 'OpenAI Local',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: 'secret:openai-local',
          enabled: true,
          models: [
            {
              id: 'qwen-local',
              displayName: 'Qwen Local',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false,
              options: {
                modelKwargs: {
                  chat_template_kwargs: {
                    enable_thinking: true
                  },
                  extra_body: {
                    trace: 'roc'
                  }
                }
              }
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<Record<string, unknown>> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as Record<string, unknown>);
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new HumanMessage('Hi')]);

    expect(result.runtime.providerType).toBe('openai_compatible');
    expect(result.runtime.modelKwargs).toEqual({
      chat_template_kwargs: {
        enable_thinking: true
      },
      extra_body: {
        trace: 'roc'
      }
    });
    expect(requests[0]).toMatchObject({
      chat_template_kwargs: {
        enable_thinking: true
      },
      extra_body: {
        trace: 'roc'
      }
    });
  });



  it('passes nested OpenAI-compatible thinking settings through explicit modelKwargs', async () => {
    services.secretService.setProviderSecret('openai-thinking-local', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 2,
      defaultModelId: 'openai-thinking-local:thinking-local',
      providers: [
        {
          id: 'openai-thinking-local',
          name: 'OpenAI Thinking Local',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: 'secret:openai-thinking-local',
          enabled: true,
          models: [
            {
              id: 'thinking-local',
              displayName: 'Thinking Local',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false,
              options: {
                modelKwargs: {
                  chat_template_kwargs: {
                    enable_thinking: true
                  }
                }
              }
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.providerType).toBe('openai_compatible');
    expect(result.runtime.modelKwargs).toEqual({
      chat_template_kwargs: {
        enable_thinking: true
      }
    });
  });



  it('does not map OpenAI-compatible thinking into chat template kwargs', async () => {
    services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 2,
      defaultModelId: 'openai-local:qwen-local',
      providers: [
        {
          id: 'openai-local',
          name: 'OpenAI Local',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: 'secret:openai-local',
          enabled: true,
          models: [
            {
              id: 'qwen-local',
              displayName: 'Qwen Local',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false,
              options: { thinking: true }
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.providerType).toBe('openai_compatible');
    expect(result.runtime.modelKwargs).toEqual({});
  });

  it('strips DeepAgents nullable grep schemas before OpenAI-compatible requests', async () => {
    services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 2,
      defaultModelId: 'openai-local:qwen-local',
      providers: [
        {
          id: 'openai-local',
          name: 'OpenAI Local',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: 'secret:openai-local',
          enabled: true,
          models: [
            {
              id: 'qwen-local',
              displayName: 'Qwen Local',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<Record<string, unknown>> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as Record<string, unknown>);
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    const grepParameters = toJsonSchema(
      z.object({
        glob: z.string().optional().nullable().default(null),
        max_count: z.coerce.number().int().positive().optional().nullable().default(null)
      })
    );
    const model = result.model as typeof result.model & {
      defaultOptions?: { tools?: unknown };
    };
    model.defaultOptions = {
      ...(model.defaultOptions ?? {}),
      tools: [
        {
          type: 'function',
          function: {
            name: 'grep',
            description: 'Search file contents',
            parameters: grepParameters
          }
        }
      ]
    };
    await result.model.invoke([new HumanMessage('Hi')]);

    const tools = requests[0]?.tools as Array<{ function?: { parameters?: unknown } }>;
    const parameters = tools[0]?.function?.parameters;
    const raw = JSON.stringify(grepParameters);
    expect(raw.includes('"not":{}') || raw.includes('"null"')).toBe(true);
    expect(JSON.stringify(parameters)).not.toContain('"not"');
    expect(JSON.stringify(parameters)).not.toContain('"anyOf"');
    expect(parameters).toMatchObject({
      type: 'object',
      properties: {
        glob: { type: 'string' },
        max_count: { type: 'integer' }
      },
      additionalProperties: false
    });
  });

});
