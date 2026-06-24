import { SystemMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import type { ProviderConfig } from '../../src/shared/types';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-langchain-model-factory-');
});
afterEach(async () => {
  await services.cleanup();
});


describe('LangChainModelFactory', () => {
  it('sends NVIDIA text-only content blocks as string chat content without streaming usage options', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'nvidia:moonshotai/kimi-k2.6',
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
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<{ messages?: Array<{ content?: unknown }>; parallel_tool_calls?: unknown; stream_options?: unknown }> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { messages?: Array<{ content?: unknown }>; parallel_tool_calls?: unknown; stream_options?: unknown });
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

    await result.model.invoke([
      new SystemMessage({
        contentBlocks: [
          {
            type: 'text',
            text: 'Roc system prompt'
          },
          {
            type: 'text',
            text: 'Deep Agents base prompt'
          }
        ]
      })
    ]);

    expect(requests[0]?.messages?.[0]?.content).toBe('Roc system prompt\n\nDeep Agents base prompt');
    expect(requests[0]).not.toHaveProperty('parallel_tool_calls');
    expect(requests[0]?.stream_options).toEqual({ include_usage: true });
  });


  it('uses empty modelKwargs for OpenAI-compatible providers without explicit modelKwargs', async () => {
    services.secretService.setProviderSecret('openai-local-empty', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'openai-local-empty:empty-local',
      providers: [
        {
          id: 'openai-local-empty',
          name: 'OpenAI Local Empty',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: 'secret:openai-local-empty',
          enabled: true,
          models: [
            {
              id: 'empty-local',
              displayName: 'Empty Local',
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

    expect(result.runtime.providerType).toBe('openai_compatible');
    expect(result.runtime.modelKwargs).toEqual({});
  });


  it('maps OpenAI responses-api provider settings into ChatOpenAI response invocation params', async () => {
    services.secretService.setProviderSecret('openai-responses', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'openai-responses:gpt-5',
      providers: [
        {
          id: 'openai-responses',
          name: 'OpenAI Responses',
          type: 'openai_compatible',
          endpoint: 'https://api.openai.example.test/v1',
          credentialRef: 'secret:openai-responses',
          enabled: true,
          models: [
            {
              id: 'gpt-5',
              displayName: 'GPT 5',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            organization: 'org-roc-responses',
            useResponsesApi: true,
            reasoning: {
              summary: 'detailed'
            },
            serviceTier: 'scale',
            verbosity: 'high',
            zdrEnabled: true
          } as ProviderConfig['options']
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: false });
    const chatModel = result.model as unknown as {
      clientConfig?: { baseURL?: string; organization?: string };
      invocationParams: () => Record<string, unknown>;
      useResponsesApi?: boolean;
    };

    expect(chatModel.useResponsesApi).toBe(true);
    expect(chatModel.clientConfig).toMatchObject({
      baseURL: 'https://api.openai.example.test/v1',
      organization: 'org-roc-responses'
    });
    expect(chatModel.invocationParams()).toMatchObject({
      model: 'gpt-5',
      service_tier: 'scale',
      reasoning: {
        summary: 'detailed'
      },
      text: {
        verbosity: 'high'
      },
      stream: false,
      store: false
    });
  });


  it('maps Anthropic-compatible advanced provider settings into ChatAnthropic configuration', async () => {
    services.secretService.setProviderSecret('anthropic-local', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'anthropic-local:claude-sonnet-4-5',
      providers: [
        {
          id: 'anthropic-local',
          name: 'Anthropic Local',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-local',
          enabled: true,
          models: [
            {
              id: 'claude-sonnet-4-5',
              displayName: 'Claude Sonnet 4.5',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            temperature: 0.1,
            maxTokens: 4096,
            topP: 0.85,
            topK: 12,
            stop: ['\n\nHuman:'],
            streamUsage: false,
            timeoutMs: 33_000,
            defaultHeaders: {
              'x-tenant': 'east'
            },
            anthropicThinking: {
              mode: 'enabled',
              budgetTokens: 2048
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.baseUrl).toBe('https://anthropic.example.test/');
    expect((result.model as {
      apiUrl?: string;
      topP?: number;
      topK?: number;
      stopSequences?: string[];
      streamUsage?: boolean;
      thinking?: unknown;
      clientOptions?: { timeout?: number; maxRetries?: number; defaultHeaders?: Record<string, string> };
    })).toMatchObject({
      apiUrl: 'https://anthropic.example.test/',
      topP: 0.85,
      topK: 12,
      stopSequences: ['\n\nHuman:'],
      streamUsage: false,
      thinking: {
        type: 'enabled',
        budget_tokens: 2048
      },
      clientOptions: {
        timeout: 33_000,
        maxRetries: 0,
        defaultHeaders: {
          'x-tenant': 'east'
        }
      }
    });
  });


  it('maps Anthropic invocationKwargs into ChatAnthropic configuration', async () => {
    services.secretService.setProviderSecret('anthropic-phase1', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'anthropic-phase1:claude-sonnet-4-6',
      providers: [
        {
          id: 'anthropic-phase1',
          name: 'Anthropic Phase 1',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-phase1',
          enabled: true,
          models: [
            {
              id: 'claude-sonnet-4-6',
              displayName: 'Claude Sonnet 4.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            maxTokens: 1000,
            invocationKwargs: {
              metadata: { user_id: 'test-user', session_id: 'test-session' }
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as { invocationKwargs?: unknown; maxTokens?: number })).toMatchObject({
      invocationKwargs: {
        metadata: { user_id: 'test-user', session_id: 'test-session' }
      },
      maxTokens: 1000
    });
  });


  it('maps Anthropic betas into ChatAnthropic configuration', async () => {
    services.secretService.setProviderSecret('anthropic-phase1', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'anthropic-phase1:claude-sonnet-4-6',
      providers: [
        {
          id: 'anthropic-phase1',
          name: 'Anthropic Phase 1',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-phase1',
          enabled: true,
          models: [
            {
              id: 'claude-sonnet-4-6',
              displayName: 'Claude Sonnet 4.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            anthropicBetas: ['prompt-caching-2024-07-31', '', 'pdfs-2024-09-25']
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as { betas?: string[] }).betas).toEqual(['prompt-caching-2024-07-31', 'pdfs-2024-09-25']);
  });

});
