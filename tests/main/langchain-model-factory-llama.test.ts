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


  it('keeps llama.cpp free of OpenAI-only reasoning, organization, service tier, and response fields', async () => {
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
          ],
          options: {
            contextBudgetTokens: 4096,
            organization: 'org_should_not_send',
            reasoning: { effort: 'medium' },
            serviceTier: 'flex',
            streamUsage: true,
            useResponsesApi: true,
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

    expect(result.runtime.streaming).toBe(true);
    expect(result.runtime.contextBudgetTokens).toBe(4096);
    expect(result.runtime.modelKwargs).toMatchObject({
      cache_prompt: true
    });
    expect(chatModel.clientConfig).toMatchObject({
      baseURL: 'http://127.0.0.1:9090/v1'
    });
    expect(chatModel.clientConfig?.organization).not.toBe('org_should_not_send');
    expect(chatModel.useResponsesApi).not.toBe(true);
    expect(chatModel.invocationParams()).not.toMatchObject({
      reasoning: expect.anything(),
      service_tier: expect.anything(),
      text: expect.anything(),
      store: false
    });
  });

});

