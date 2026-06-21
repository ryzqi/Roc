import { AIMessageChunk, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';
import { LangChainModelFactory, resolveAnthropicBetas } from '../../src/main/services/langchain-model-factory';
import type { ProviderConfig, ProviderOptions } from '../../src/shared/types';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-langchain-model-factory-');
});
afterEach(async () => {
  await services.cleanup();
});



describe('LangChainModelFactory', () => {
  it('keeps OpenAI-compatible models on the standard provider request timeout', async () => {
    services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen-local',
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
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as { timeout?: number }).timeout).toBe(120_000);
  });



  it('builds the fixed OpenRouter ChatOpenAI model with OpenRouter attribution headers', async () => {
    services.secretService.setProviderSecret('openrouter', 'sk-or-v1-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: '~openai/gpt-latest',
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          type: 'openrouter',
          endpoint: 'https://openrouter.ai/api/v1',
          credentialRef: 'secret:openrouter',
          enabled: true,
          models: [
            {
              id: '~openai/gpt-latest',
              displayName: 'OpenAI GPT Latest',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: false });

    expect(result.provider.id).toBe('openrouter');
    expect(result.runtime.providerType).toBe('openrouter');
    expect(result.runtime.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect((result.model as { clientConfig?: { baseURL?: string; defaultHeaders?: Record<string, string> } }).clientConfig)
      .toMatchObject({
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/roc-ai/roc',
          'X-OpenRouter-Title': 'Roc'
        }
      });
  });



  it('does not apply OpenAI-only advanced params to OpenRouter models', async () => {
    services.secretService.setProviderSecret('openrouter', 'sk-or-v1-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: '~openai/gpt-latest',
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          type: 'openrouter',
          endpoint: 'https://openrouter.ai/api/v1',
          credentialRef: 'secret:openrouter',
          enabled: true,
          models: [
            {
              id: '~openai/gpt-latest',
              displayName: 'OpenAI GPT Latest',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            defaultHeaders: { 'x-custom': 'must-not-send' },
            reasoning: { effort: 'high', summary: 'detailed' },
            serviceTier: 'priority',
            useResponsesApi: true,
            verbosity: 'high',
            zdrEnabled: true
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: false });
    const chatModel = result.model as unknown as {
      clientConfig?: { baseURL?: string; defaultHeaders?: Record<string, string> };
      invocationParams: () => Record<string, unknown>;
      useResponsesApi?: boolean;
    };

    expect(chatModel.clientConfig).toMatchObject({
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/roc-ai/roc',
        'X-OpenRouter-Title': 'Roc'
      }
    });
    expect(chatModel.clientConfig?.defaultHeaders).not.toHaveProperty('x-custom');
    expect(chatModel.useResponsesApi).not.toBe(true);
    expect(chatModel.invocationParams()).not.toMatchObject({
      reasoning: expect.anything(),
      service_tier: expect.anything(),
      text: expect.anything(),
      store: false
    });
  });



  it('sanitizes llama.cpp tool schemas before grammar generation', async () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen3.5-4b',
      providers: [
        {
          id: 'llama_cpp',
          name: 'llama.cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: null,
          enabled: true,
          models: [
            {
              id: 'qwen3.5-4b',
              displayName: 'Qwen 3.5 4B',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: false });
    expect(result.runtime.streaming).toBe(true);
    const requests: Array<{
      cache_prompt?: unknown;
      parallel_tool_calls?: unknown;
      stream?: unknown;
      stream_options?: unknown;
      tools?: Array<{ function?: { parameters?: unknown } }>;
    }> = [];
    const completionModel = (result.model as ChatOpenAI).bindTools([
      tool(async () => 'ok', {
        name: 'schedule_once',
        description: 'Schedule a one-time task.',
        schema: z.object({
          nextRunAt: z.string().datetime(),
          goal: z.string().min(1).max(500)
        })
      })
    ]) as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => Promise<AsyncIterable<unknown>>;
      };
      invoke: (input: unknown) => Promise<unknown>;
    };
    completionModel.completions.completionWithRetry = async (request) => {
      requests.push(
        request as {
          cache_prompt?: unknown;
          parallel_tool_calls?: unknown;
          stream?: unknown;
          stream_options?: unknown;
          tools?: Array<{ function?: { parameters?: unknown } }>;
        }
      );
      return (async function* () {
        yield {
          choices: [
            {
              delta: {
                role: 'assistant',
                content: 'OK'
              },
              finish_reason: 'stop',
              index: 0
            }
          ]
        };
      })();
    };

    await completionModel.invoke('Reply OK without calling tools.');

    expect(requests[0]).toMatchObject({
      cache_prompt: true,
      stream: true,
      parallel_tool_calls: false
    });
    expect(requests[0]).not.toHaveProperty('stream_options');
    expect(requests[0]?.tools?.[0]?.function?.parameters).toEqual({
      type: 'object',
      required: ['nextRunAt', 'goal'],
      properties: {
        nextRunAt: {
          type: 'string',
          description: expect.stringContaining('ISO 8601 UTC timestamp')
        },
        goal: {
          type: 'string'
        }
      }
    });
  });



  it('keeps OpenAI-compatible non-streaming requests on the non-streaming path', async () => {
    services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen-local',
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
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: false });
    const requests: Array<{ stream?: unknown }> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => Promise<unknown>;
      };
      invoke: (input: unknown) => Promise<unknown>;
    };
    completionModel.completions.completionWithRetry = async (request) => {
      requests.push(request as { stream?: unknown });
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'OK'
            },
            finish_reason: 'stop',
            index: 0
          }
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2
        }
      };
    };

    await completionModel.invoke('Reply OK without calling tools.');

    expect(result.runtime.streaming).toBe(false);
    expect(requests[0]?.stream).toBe(false);
  });



  it('maps OpenAI-compatible advanced provider settings into ChatOpenAI configuration and request defaults', async () => {
    services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen-local',
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
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.25,
            maxTokens: 2048,
            topP: 0.7,
            frequencyPenalty: 0.4,
            presencePenalty: 0.15,
            stop: ['DONE'],
            seed: 42,
            organization: 'org-roc',
            streamUsage: false,
            parallelToolCalls: true,
            serviceTier: 'flex',
            timeoutMs: 45_000,
            verbosity: 'low',
            defaultHeaders: {
              'x-client': 'roc'
            }
          } as ProviderConfig['options']
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

    expect(result.runtime.baseUrl).toBe('http://127.0.0.1:9090/v1');
    expect((result.model as { timeout?: number }).timeout).toBe(45_000);
    expect(
      (result.model as {
        clientConfig?: { baseURL?: string; organization?: string; defaultHeaders?: Record<string, string> };
      }).clientConfig
    )
      .toMatchObject({
        baseURL: 'http://127.0.0.1:9090/v1',
        organization: 'org-roc',
        defaultHeaders: {
          'x-client': 'roc'
        }
      });
    expect(requests[0]).toMatchObject({
      top_p: 0.7,
      frequency_penalty: 0.4,
      presence_penalty: 0.15,
      stop: ['DONE'],
      seed: 42,
      parallel_tool_calls: true,
      service_tier: 'flex',
      verbosity: 'low',
      stream: true
    });
    expect(requests[0]).not.toHaveProperty('stream_options');
  });


});

