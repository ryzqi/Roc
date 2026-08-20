import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderTestServices, type ProviderTestServices } from '../provider-test-fixture';
import { LangChainModelFactory } from '../../../src/main/services/langchain-model-factory';
import { buildProviderModelKey } from '../../../src/shared/provider-model-key';
import type { ProviderConfig, ProviderModelOptions } from '../../../src/shared/types';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-langchain-model-factory-sampling-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await services.cleanup();
});

describe('LangChainModelFactory llama.cpp sampling defaults', () => {
  it('applies Qwen3 family sampling defaults to llama.cpp models', async () => {
    saveProviders([
      llamaCppProvider({
        modelId: 'Qwen3-8B-Instruct.Q8_0.gguf',
        options: { contextBudgetTokens: 4096 }
      })
    ]);

    const result = await new LangChainModelFactory(services.configService, services.secretService).createDefaultChatModel();

    expect(readSamplingFields(result.model)).toMatchObject({
      temperature: 0.6,
      topP: 0.95,
      modelKwargs: {
        cache_prompt: true,
        top_k: 20
      }
    });
    expect(result.runtime.contextBudgetTokens).toBe(4096);
  });

  it('lets samplingProfileOverrides replace family defaults field by field', async () => {
    saveProviders([
      llamaCppProvider({
        modelId: 'Qwen3-8B-Instruct.Q8_0.gguf',
        options: {
          samplingProfileOverrides: { temperature: 0.8 }
        }
      })
    ]);

    const result = await new LangChainModelFactory(services.configService, services.secretService).createDefaultChatModel();

    expect(readSamplingFields(result.model)).toMatchObject({
      temperature: 0.8,
      topP: 0.95,
      modelKwargs: {
        cache_prompt: true,
        top_k: 20
      }
    });
  });

  it('treats zero-valued samplingProfileOverrides as explicit values', async () => {
    saveProviders([
      llamaCppProvider({
        modelId: 'Qwen3-8B-Instruct.Q8_0.gguf',
        options: {
          samplingProfileOverrides: { temperature: 0 }
        }
      })
    ]);

    const result = await new LangChainModelFactory(services.configService, services.secretService).createDefaultChatModel();

    expect(readSamplingFields(result.model).temperature).toBe(0);
  });

  it('logs unknown local model families without forcing sampling defaults', async () => {
    const logService = {
      info: vi.fn(),
      warn: vi.fn()
    };
    saveProviders([llamaCppProvider({ modelId: 'llama-3.1' })]);

    const result = await new LangChainModelFactory(services.configService, services.secretService, logService as never).createDefaultChatModel();

    expect(logService.info).toHaveBeenCalledWith('Provider local model family is unknown.', {
      service: 'langchain-model-factory',
      component: 'resolveLlamaCppSamplingProfile',
      metadata: {
        providerId: 'llama_cpp',
        modelId: 'llama-3.1'
      }
    });
    expect(readSamplingFields(result.model)).toMatchObject({
      temperature: undefined,
      topP: undefined,
      modelKwargs: {
        cache_prompt: true
      }
    });
  });

  it('does not run local family logging for cloud providers', async () => {
    const logService = {
      info: vi.fn(),
      warn: vi.fn()
    };
    services.secretService.setProviderSecret('openai-cloud', 'sk-test');
    saveProviders([
      {
        id: 'openai-cloud',
        name: 'OpenAI Cloud',
        type: 'openai_compatible',
        endpoint: 'https://api.openai.com/v1',
        credentialRef: 'secret:openai-cloud',
        enabled: true,
        models: [
          {
            id: 'llama-3.1',
            displayName: 'Cloud model',
            enabled: true,
            supportsStreaming: true,
            supportsToolCalls: true,
            supportsImages: false
          }
        ]
      }
    ]);

    const result = await new LangChainModelFactory(services.configService, services.secretService, logService as never).createDefaultChatModel();

    expect(logService.info).not.toHaveBeenCalled();
    expect(result.runtime.modelKwargs).toEqual({});
  });
});

function saveProviders(providers: ProviderConfig[]): void {
  services.configService.saveProviders({
    schemaVersion: 2,
    defaultModelId: buildProviderModelKey(providers[0]!.id, providers[0]!.models[0]!.id),
    providers
  });
}
function llamaCppProvider(input: { modelId: string; options?: ProviderModelOptions }): ProviderConfig {
  return {
    id: 'llama_cpp',
    name: 'llama.cpp',
    type: 'llama_cpp',
    endpoint: 'http://127.0.0.1:9090/v1',
    credentialRef: null,
    enabled: true,
    models: [
      {
        id: input.modelId,
        displayName: input.modelId,
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImages: false,
        options: input.options
      }
    ]
  };
}

function readSamplingFields(model: unknown): {
  temperature?: number;
  topP?: number;
  modelKwargs?: Record<string, unknown>;
} {
  return model as {
    temperature?: number;
    topP?: number;
    modelKwargs?: Record<string, unknown>;
  };
}
