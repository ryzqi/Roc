import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-langchain-model-factory-');
});
afterEach(async () => {
  await services.cleanup();
});


describe('LangChainModelFactory', () => {
  it('builds a fixed NVIDIA ChatOpenAI model with thinking kwargs', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'moonshotai/kimi-k2.6',
      providers: [
        {
          id: 'nvidia',
          name: 'NVIDIA',
          type: 'nvidia',
          endpoint: 'https://integrate.api.nvidia.com/v1',
          credentialRef: 'secret:nvidia',
          enabled: true,
          models: [
            {
              id: 'moonshotai/kimi-k2.6',
              displayName: 'Kimi K2.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            thinking: true,
            temperature: 0.2,
            maxTokens: 2048
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel();

    expect(result.provider.id).toBe('nvidia');
    expect(result.modelId).toBe('moonshotai/kimi-k2.6');
    expect(result.runtime.providerType).toBe('nvidia');
    expect(result.runtime.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(result.runtime.streaming).toBe(true);
    expect(result.runtime.modelKwargs).toMatchObject({
      chat_template_kwargs: {
        thinking: true
      }
    });
    expect((result.model as { timeout?: number }).timeout).toBe(120_000);
    expect((result.model as { clientConfig?: { maxRetries?: number } }).clientConfig?.maxRetries).toBe(0);
  });


  it('simplifies NVIDIA tool schemas before sending OpenAI tool definitions', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'moonshotai/kimi-k2.6',
      providers: [
        {
          id: 'nvidia',
          name: 'NVIDIA',
          type: 'nvidia',
          endpoint: 'https://integrate.api.nvidia.com/v1',
          credentialRef: 'secret:nvidia',
          enabled: true,
          models: [
            {
              id: 'moonshotai/kimi-k2.6',
              displayName: 'Kimi K2.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<{ tools?: Array<{ function?: { parameters?: unknown } }> }> = [];
    const completionModel = (result.model as ChatOpenAI).bindTools([
      tool(async () => 'ok', {
        name: 'lookup',
        description: 'Lookup a value.',
        schema: {
          type: 'object',
          $schema: 'http://json-schema.org/draft-07/schema#',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: {
              anyOf: [
                {
                  type: 'string'
                },
                {
                  type: 'null'
                }
              ],
              default: null,
              description: 'Lookup query.'
            },
            limit: {
              type: 'integer',
              default: 5,
              additionalProperties: {
                type: 'string'
              }
            }
          }
        }
      })
    ]) as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
      invoke: (input: unknown) => Promise<unknown>;
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { tools?: Array<{ function?: { parameters?: unknown } }> });
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

    await completionModel.invoke('Use no tools and reply OK.');

    expect(requests[0]?.tools?.[0]?.function?.parameters).toEqual({
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Lookup query.'
        },
        limit: {
          type: 'integer'
        }
      }
    });
  });


  it('builds anthropic-compatible models with a 60 second request timeout', async () => {
    services.secretService.setProviderSecret('anthropic-local', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'claude-sonnet-4-5',
      providers: [
        {
          id: 'anthropic-local',
          name: 'Anthropic Local',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test/v1/messages',
          credentialRef: 'secret:anthropic-local',
          enabled: true,
          models: [
            {
              id: 'claude-sonnet-4-5',
              displayName: 'Claude Sonnet 4.5',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel();

    expect(result.provider.id).toBe('anthropic-local');
    expect(result.modelId).toBe('claude-sonnet-4-5');
    expect((result.model as { clientOptions?: { timeout?: number; maxRetries?: number } }).clientOptions).toMatchObject({
      timeout: 120_000,
      maxRetries: 0
    });
  });

});

