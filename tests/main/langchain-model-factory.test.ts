import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessageChunk, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { LangChainModelFactory, resolveAnthropicBetas } from '../../src/main/services/langchain-model-factory';
import type { ProviderConfig, ProviderOptions } from '../../src/shared/types';

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
  describe('resolveAnthropicBetas', () => {
    it('filters empty beta strings', () => {
      expect(resolveAnthropicBetas(['valid-beta', '', 'another-valid'])).toEqual(['valid-beta', 'another-valid']);
    });

    it('filters whitespace-only beta strings', () => {
      expect(resolveAnthropicBetas(['valid', '  ', '\t', 'also-valid'])).toEqual(['valid', 'also-valid']);
    });

    it('returns an empty array for an empty array', () => {
      expect(resolveAnthropicBetas([])).toEqual([]);
    });

    it('keeps all valid beta strings', () => {
      const betas = ['prompt-caching-2024-07-31', 'pdfs-2024-09-25'];

      expect(resolveAnthropicBetas(betas)).toEqual(betas);
    });
  });

  describe('buildAnthropicClientOptions', () => {
    it('uses provider timeout when configured', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): {
          timeout?: number;
          maxRetries?: number;
        };
      };
      const provider = {
        type: 'anthropic_compatible',
        options: {
          timeoutMs: 30_000
        }
      } as unknown as ProviderConfig;

      const result = factory.buildAnthropicClientOptions(provider, 60_000);

      expect(result.timeout).toBe(30_000);
      expect(result.maxRetries).toBe(0);
    });

    it('uses the default timeout when provider timeout is not configured', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): {
          timeout?: number;
        };
      };
      const provider = {
        type: 'anthropic_compatible',
        options: {}
      } as unknown as ProviderConfig;

      const result = factory.buildAnthropicClientOptions(provider, 60_000);

      expect(result.timeout).toBe(60_000);
    });

    it('includes default headers when configured', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): {
          defaultHeaders?: Record<string, string>;
        };
      };
      const provider = {
        type: 'anthropic_compatible',
        options: {
          defaultHeaders: { 'X-Custom': 'value' }
        }
      } as unknown as ProviderConfig;

      const result = factory.buildAnthropicClientOptions(provider, 60_000);

      expect(result.defaultHeaders).toEqual({ 'X-Custom': 'value' });
    });

    it('omits default headers when they are not configured', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): {
          defaultHeaders?: Record<string, string>;
        };
      };
      const provider = {
        type: 'anthropic_compatible',
        options: {}
      } as unknown as ProviderConfig;

      const result = factory.buildAnthropicClientOptions(provider, 60_000);

      expect(result.defaultHeaders).toBeUndefined();
    });
  });

  describe('applyAnthropicSamplingParams', () => {
    it('applies all configured sampling params', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicSamplingParams(config: Record<string, unknown>, options: ProviderOptions): void;
      };
      const config: Record<string, unknown> = {};
      const options: ProviderOptions = {
        temperature: 0.7,
        maxTokens: 1000,
        topP: 0.9,
        topK: 10,
        stop: ['stop1', 'stop2']
      };

      factory.applyAnthropicSamplingParams(config, options);

      expect(config.temperature).toBe(0.7);
      expect(config.maxTokens).toBe(1000);
      expect(config.topP).toBe(0.9);
      expect(config.topK).toBe(10);
      expect(config.stopSequences).toEqual(['stop1', 'stop2']);
    });

    it('skips undefined sampling params', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicSamplingParams(config: Record<string, unknown>, options: ProviderOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicSamplingParams(config, { temperature: 0.7 });

      expect(config.temperature).toBe(0.7);
      expect(config.maxTokens).toBeUndefined();
      expect(config.topP).toBeUndefined();
    });

    it('skips empty stop arrays', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicSamplingParams(config: Record<string, unknown>, options: ProviderOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicSamplingParams(config, { stop: [] });

      expect(config.stopSequences).toBeUndefined();
    });
  });

  describe('applyAnthropicPhase1Features', () => {
    it('applies configured Anthropic betas', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicPhase1Features(config: Record<string, unknown>, options: ProviderOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicPhase1Features(config, {
        anthropicBetas: ['prompt-caching-2024-07-31', 'pdfs-2024-09-25']
      });

      expect(config.betas).toEqual(['prompt-caching-2024-07-31', 'pdfs-2024-09-25']);
    });

    it('applies invocation kwargs', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicPhase1Features(config: Record<string, unknown>, options: ProviderOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicPhase1Features(config, {
        invocationKwargs: { metadata: { user_id: 'test' } }
      });

      expect(config.invocationKwargs).toEqual({ metadata: { user_id: 'test' } });
    });

    it('skips undefined phase 1 options', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicPhase1Features(config: Record<string, unknown>, options: ProviderOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicPhase1Features(config, {});

      expect(config.betas).toBeUndefined();
      expect(config.invocationKwargs).toBeUndefined();
    });

    it('omits empty beta arrays', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicPhase1Features(config: Record<string, unknown>, options: ProviderOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicPhase1Features(config, { anthropicBetas: [] });

      expect(config.betas).toBeUndefined();
    });

    it('omits betas when every configured value is empty', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicPhase1Features(config: Record<string, unknown>, options: ProviderOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicPhase1Features(config, { anthropicBetas: ['', '  '] });

      expect(config.betas).toBeUndefined();
    });
  });

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

  it('resolves cheap model handle to the active handle when no explicit cheap model is configured', async () => {
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
    const active = await factory.createDefaultChatModel({ streaming: false });

    expect(factory.resolveCheapModelHandle(active)).toBe(active);
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
    expect(requests[0]).not.toHaveProperty('parallel_tool_calls');
    expect(requests[0]?.stream_options).toEqual({ include_usage: true });
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
      cache_prompt: true,
      top_k: 20
    });
    expect((result.model as { temperature?: number; topP?: number }).temperature).toBe(1);
    expect((result.model as { temperature?: number; topP?: number }).topP).toBe(0.95);
    expect(result.runtime.contextBudgetTokens).toBe(8192);
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

  it('maps OpenAI responses-api provider settings into ChatOpenAI response invocation params', async () => {
    services.secretService.setProviderSecret('openai-responses', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'gpt-5',
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
              supportsToolCalls: true
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
      defaultModelId: 'claude-sonnet-4-5',
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
              supportsToolCalls: true
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
      defaultModelId: 'claude-sonnet-4-6',
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
              supportsToolCalls: true
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
      defaultModelId: 'claude-sonnet-4-6',
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
              supportsToolCalls: true
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

  it('keeps Anthropic-compatible behavior unchanged without phase 1 fields', async () => {
    services.secretService.setProviderSecret('anthropic-phase1', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'claude-sonnet-4-6',
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
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.7,
            maxTokens: 2000
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as {
      temperature?: number;
      maxTokens?: number;
      betas?: string[];
      invocationKwargs?: Record<string, unknown>;
    })).toMatchObject({
      temperature: 0.7,
      maxTokens: 2000,
      invocationKwargs: {}
    });
    expect((result.model as { betas?: string[] }).betas).toBeUndefined();
  });

  it('maps combined Anthropic phase 1 and thinking options into ChatAnthropic configuration', async () => {
    services.secretService.setProviderSecret('anthropic-phase1', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'claude-opus-4-6',
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
              id: 'claude-opus-4-6',
              displayName: 'Claude Opus 4.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.8,
            maxTokens: 4000,
            anthropicBetas: ['prompt-caching-2024-07-31'],
            anthropicThinking: { mode: 'adaptive' },
            invocationKwargs: {
              metadata: { app_version: '1.0.0' }
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as {
      temperature?: number;
      maxTokens?: number;
      thinking?: unknown;
      betas?: string[];
      invocationKwargs?: unknown;
    })).toMatchObject({
      temperature: 0.8,
      maxTokens: 4000,
      thinking: { type: 'adaptive' },
      betas: ['prompt-caching-2024-07-31'],
      invocationKwargs: {
        metadata: { app_version: '1.0.0' }
      }
    });
  });

  it('maps explicit OpenAI-compatible reasoning none into OpenAI reasoning requests', async () => {
    services.secretService.setProviderSecret('openai-reasoning-none', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'gpt-5.1',
      providers: [
        {
          id: 'openai-reasoning-none',
          name: 'OpenAI Reasoning None',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: 'secret:openai-reasoning-none',
          enabled: true,
          models: [
            {
              id: 'gpt-5.1',
              displayName: 'GPT 5.1',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            reasoning: {
              effort: 'none'
            }
          }
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
      reasoning?: unknown;
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as Record<string, unknown>);
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new HumanMessage('Hi')]);

    expect(completionModel.reasoning).toEqual({
      effort: 'none'
    });
    expect(requests[0]).toMatchObject({
      reasoning_effort: 'none',
      stream: true
    });
  });

  it('rejects Anthropic enabled thinking budgets below the official minimum at runtime', async () => {
    services.secretService.setProviderSecret('anthropic-runtime-invalid', 'sk-ant-test');

    const factory = new LangChainModelFactory(services.configService, services.secretService);

    await expect(
      factory.createModelForProvider(
        {
          id: 'anthropic-runtime-invalid',
          name: 'Anthropic Runtime Invalid',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-runtime-invalid',
          enabled: true,
          models: [
            {
              id: 'claude-sonnet-4-5',
              displayName: 'Claude Sonnet 4.5',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            maxTokens: 4096,
            anthropicThinking: {
              mode: 'enabled',
              budgetTokens: 1023
            }
          }
        },
        'claude-sonnet-4-5',
        { streaming: true }
      )
    ).rejects.toThrow('Anthropic thinking budget tokens 必须大于等于 1024。');
  });

  it('maps explicit Anthropic disabled thinking into ChatAnthropic configuration', async () => {
    services.secretService.setProviderSecret('anthropic-disabled', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'claude-opus-4-6',
      providers: [
        {
          id: 'anthropic-disabled',
          name: 'Anthropic Disabled',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-disabled',
          enabled: true,
          models: [
            {
              id: 'claude-opus-4-6',
              displayName: 'Claude Opus 4.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            anthropicThinking: {
              mode: 'disabled'
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as { thinking?: unknown }).thinking).toEqual({
      type: 'disabled'
    });
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

    const logService = {
      info: vi.fn(),
      warn: vi.fn()
    };
    const originalDefaultOptions = (ChatAnthropic.prototype as { defaultOptions?: unknown }).defaultOptions;
    (ChatAnthropic.prototype as { defaultOptions?: unknown }).defaultOptions = {
      cache_control: {
        type: 'ephemeral'
      }
    };

    try {
      const factory = new LangChainModelFactory(services.configService, services.secretService, logService as never);
      await factory.createDefaultChatModel({ streaming: true });

      expect(logService.warn).toHaveBeenCalledWith('Anthropic model retained cache_control defaults.', {
        service: 'langchain-model-factory',
        component: 'warnIfAnthropicCacheControlConfigured'
      });
    } finally {
      if (originalDefaultOptions === undefined) {
        delete (ChatAnthropic.prototype as { defaultOptions?: unknown }).defaultOptions;
      } else {
        (ChatAnthropic.prototype as { defaultOptions?: unknown }).defaultOptions = originalDefaultOptions;
      }
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

  it('uses enable_thinking for qwen models on NVIDIA', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen/qwen3-235b-a22b',
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
              id: 'qwen/qwen3-235b-a22b',
              displayName: 'Qwen3 235B',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: { thinking: true }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.modelKwargs).toMatchObject({
      chat_template_kwargs: {
        enable_thinking: true
      }
    });
    expect(result.runtime.modelKwargs).not.toHaveProperty('chat_template_kwargs.thinking');
  });

  it('injects detailed thinking system messages for nemotron models', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'nvidia/llama-3.3-nemotron-super-49b-v1',
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
              id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
              displayName: 'Nemotron Super 49B',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: { thinking: true }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { messages?: Array<{ role: string; content: unknown }> });
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new SystemMessage('Roc system prompt'), new HumanMessage('Hello')]);

    expect(result.runtime.modelKwargs).not.toHaveProperty('chat_template_kwargs');
    expect(requests[0]?.messages?.[0]).toMatchObject({
      role: 'system',
      content: 'detailed thinking on'
    });
    expect(requests[0]?.messages?.[1]).toMatchObject({
      role: 'system',
      content: 'Roc system prompt'
    });
  });

  it('injects detailed thinking off when thinking is disabled for nemotron models', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'nvidia/llama-3.3-nemotron-super-49b-v1',
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
              id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
              displayName: 'Nemotron Super 49B',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: { thinking: false }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { messages?: Array<{ role: string; content: unknown }> });
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new HumanMessage('Hello')]);

    expect(requests[0]?.messages?.[0]).toMatchObject({
      role: 'system',
      content: 'detailed thinking off'
    });
  });

  it('enables stream_options.include_usage by default for NVIDIA streaming', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
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
    const requests: Array<{ stream_options?: unknown; parallel_tool_calls?: unknown }> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { stream_options?: unknown; parallel_tool_calls?: unknown });
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new HumanMessage('Hi')]);

    expect(requests[0]?.stream_options).toEqual({ include_usage: true });
    expect(requests[0]).not.toHaveProperty('parallel_tool_calls');
  });

  it('respects NVIDIA stream usage and parallel tool call options', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: { streamUsage: false, parallelToolCalls: true }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<{ stream_options?: unknown; parallel_tool_calls?: unknown }> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { stream_options?: unknown; parallel_tool_calls?: unknown });
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new HumanMessage('Hi')]);

    expect(requests[0]?.stream_options).toBeUndefined();
    expect(requests[0]?.parallel_tool_calls).toBe(true);
  });

  it('passes NVIDIA tool_choice options to the request body', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            toolChoice: {
              type: 'function',
              function: {
                name: 'lookup'
              }
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<{ tool_choice?: unknown }> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { tool_choice?: unknown });
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new HumanMessage('Hi')]);

    expect(requests[0]?.tool_choice).toEqual({
      type: 'function',
      function: {
        name: 'lookup'
      }
    });
  });

  it('uses endpointOverride as baseURL when set on NVIDIA provider', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: { endpointOverride: 'http://localhost:8000/v1' }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.baseUrl).toBe('http://localhost:8000/v1');
    expect((result.model as { clientConfig?: { baseURL?: string } }).clientConfig?.baseURL).toBe('http://localhost:8000/v1');
  });

  it('sends include_reasoning only in non-streaming NVIDIA requests', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen/qwen3-235b-a22b',
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
              id: 'qwen/qwen3-235b-a22b',
              displayName: 'Qwen3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: { includeReasoning: false }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const nonStreaming = await factory.createDefaultChatModel({ streaming: false });
    const streaming = await factory.createDefaultChatModel({ streaming: true });

    expect(nonStreaming.runtime.modelKwargs).toMatchObject({ include_reasoning: false });
    expect(streaming.runtime.modelKwargs).not.toHaveProperty('include_reasoning');
  });

  it('merges guided generation options into NVIDIA nvext', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            guidedJson: { type: 'object', properties: { name: { type: 'string' } } },
            guidedChoice: ['yes', 'no'],
            guidedRegex: '^[A-Z]{3}-\\d{4}$',
            guidedGrammar: '?start: "ok"'
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.modelKwargs).toMatchObject({
      nvext: {
        guided_json: { type: 'object', properties: { name: { type: 'string' } } },
        guided_choice: ['yes', 'no'],
        guided_regex: '^[A-Z]{3}-\\d{4}$',
        guided_grammar: '?start: "ok"'
      }
    });
  });

  it('omits NVIDIA nvext when no guided generation options are set', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
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

    expect(result.runtime.modelKwargs).not.toHaveProperty('nvext');
  });

  it('passes high-fidelity sampling parameters to NVIDIA request body', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen/qwen3-235b-a22b',
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
              id: 'qwen/qwen3-235b-a22b',
              displayName: 'Qwen3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            topP: 0.95,
            topK: 20,
            minP: 0,
            frequencyPenalty: 0.1,
            presencePenalty: 0.2,
            repetitionPenalty: 1.05,
            seed: 42,
            stop: ['<|end|>'],
            thinking: true
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.modelKwargs).toMatchObject({
      chat_template_kwargs: { enable_thinking: true },
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      repetition_penalty: 1.05,
      seed: 42,
      stop: ['<|end|>']
    });
  });

  it('extracts reasoning_content into reasoning content block in non-streaming NVIDIA responses', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen/qwen3-235b-a22b',
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
              id: 'qwen/qwen3-235b-a22b',
              displayName: 'Qwen3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: { thinking: true }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: false });
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => Promise<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Final answer',
            reasoning_content: 'Let me think...',
            reasoningContent: 'Let me think...'
          },
          finish_reason: 'stop',
          index: 0
        }
      ]
    });

    const output = await result.model.invoke([new HumanMessage('Q')]);

    expect(output.contentBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', reasoning: 'Let me think...' }),
        expect.objectContaining({ type: 'text', text: 'Final answer' })
      ])
    );
  });
});
