import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessageChunk, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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


  it('uses thinking plus reasoning_effort for DeepSeek V4 Flash on NVIDIA', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'deepseek-ai/deepseek-v4-flash',
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
              id: 'deepseek-ai/deepseek-v4-flash',
              displayName: 'DeepSeek V4 Flash',
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
        thinking: true
      },
      reasoning_effort: 'medium'
    });
    expect(result.runtime.modelKwargs).not.toHaveProperty('chat_template_kwargs.enable_thinking');
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

});

