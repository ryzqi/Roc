import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessageChunk, SystemMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-langchain-model-factory-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
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
    expect((result.model as { timeout?: number }).timeout).toBe(60_000);
    expect((result.model as { clientConfig?: { maxRetries?: number } }).clientConfig?.maxRetries).toBe(0);
  });

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

    expect((result.model as { timeout?: number }).timeout).toBe(60_000);
  });

  it('sends NVIDIA text-only content blocks as string chat content without streaming usage options', async () => {
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
    expect(requests[0]?.parallel_tool_calls).toBe(false);
    expect(requests[0]?.stream_options).toBeUndefined();
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
      timeout: 60_000,
      maxRetries: 0
    });
  });

  it('builds a fixed llama.cpp ChatOpenAI model with cache_prompt and no API key requirement', async () => {
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

    expect(result.provider.id).toBe('llama_cpp');
    expect(result.modelId).toBe('qwen3.5-4b');
    expect(result.runtime.providerType).toBe('llama_cpp');
    expect(result.runtime.baseUrl).toBe('http://127.0.0.1:9090/v1');
    expect(result.runtime.streaming).toBe(true);
    expect(result.runtime.modelKwargs).toEqual({
      cache_prompt: true
    });
    expect((result.model as { clientConfig?: { baseURL?: string; maxRetries?: number } }).clientConfig).toMatchObject({
      baseURL: 'http://127.0.0.1:9090/v1',
      maxRetries: 0
    });
    expect((result.model as { timeout?: number }).timeout).toBe(600_000);
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

  it('ignores legacy Anthropic cache TTL inputs and leaves cache_control to deepagents middleware', async () => {
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
    const result = await factory.createDefaultChatModel({ streaming: true, cacheTtl: '1h' } as never);

    expect((result.model as { defaultOptions?: { cache_control?: { type: string; ttl?: string } } }).defaultOptions?.cache_control).toBeUndefined();
  });

  it('warns if an Anthropic-compatible model still carries cache_control defaults after construction', async () => {
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalDefaultOptions = (ChatAnthropic.prototype as { defaultOptions?: unknown }).defaultOptions;
    (ChatAnthropic.prototype as { defaultOptions?: unknown }).defaultOptions = {
      cache_control: {
        type: 'ephemeral'
      }
    };

    try {
      const factory = new LangChainModelFactory(services.configService, services.secretService);
      await factory.createDefaultChatModel({ streaming: true });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cache_control'));
    } finally {
      if (originalDefaultOptions === undefined) {
        delete (ChatAnthropic.prototype as { defaultOptions?: unknown }).defaultOptions;
      } else {
        (ChatAnthropic.prototype as { defaultOptions?: unknown }).defaultOptions = originalDefaultOptions;
      }
      warnSpy.mockRestore();
    }
  });

  it('preserves reasoning deltas from provider reasoning_content after withConfig on streaming OpenAI-compatible models', async () => {
    services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen-local',
      providers: [
        {
          id: 'openai-local',
          name: 'OpenAI Local',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:8081/v1',
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
    const configuredModel = (result.model as ChatOpenAI).withConfig({
      stop: ['\n']
    }) as unknown as ChatOpenAI;
    const completionModel = configuredModel as unknown as {
      completions: {
        _streamResponseChunks: () => AsyncGenerator<ChatGenerationChunk>;
      };
    };

    completionModel.completions._streamResponseChunks = async function* () {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: 'OK',
          additional_kwargs: {
            reasoning_content: 'Thinking'
          }
        }),
        text: 'OK',
        generationInfo: {
          prompt: 0,
          completion: 0
        }
      });
    };

    const stream = configuredModel.streamV2('Reply with OK only.');
    const reasoningDeltas: string[] = [];
    for await (const delta of stream.reasoning) {
      reasoningDeltas.push(delta);
    }
    const textDeltas: string[] = [];
    for await (const delta of stream.text) {
      textDeltas.push(delta);
    }
    const output = await stream;

    expect(reasoningDeltas).toEqual(['Thinking']);
    expect(textDeltas).toEqual(['OK']);
    expect(output.contentBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          reasoning: 'Thinking'
        }),
        expect.objectContaining({
          type: 'text',
          text: 'OK'
        })
      ])
    );
  });
});
