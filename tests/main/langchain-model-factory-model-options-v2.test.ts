import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-model-options-v2-');
  services.secretService.setProviderSecret('p', 'sk-test');
  services.configService.saveProviders({
    schemaVersion: 2,
    defaultModelId: 'p:a',
    providers: [{
      id: 'p',
      name: 'Provider',
      type: 'openai_compatible',
      endpoint: 'https://example.test/v1',
      credentialRef: 'secret:p',
      enabled: true,
      models: [
        { id: 'a', displayName: 'A', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false, options: { temperature: 0.1, maxTokens: 100, contextBudgetTokens: 4096 } },
        { id: 'b', displayName: 'B', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false, options: { temperature: 0.8, maxTokens: 200, contextBudgetTokens: 8192 } },
        { id: 'c', displayName: 'C', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false },
        { id: 'd', displayName: 'D', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false, options: { temperature: 0.3 } }
      ]
    }]
  });
});

afterEach(async () => {
  await services.cleanup();
});

describe('LangChainModelFactory model options v2', () => {
  it('uses the selected model options independently', async () => {
    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const a = await factory.createChatModelByProviderAndModel('p', 'a', { streaming: false });
    const b = await factory.createChatModelByProviderAndModel('p', 'b', { streaming: false });
    expect(a.model).toMatchObject({ temperature: 0.1, maxTokens: 100 });
    expect(b.model).toMatchObject({ temperature: 0.8, maxTokens: 200 });
    expect(a.runtime.contextBudgetTokens).toBe(4096);
    expect(b.runtime.contextBudgetTokens).toBe(8192);
  });

  it('uses 500000 when the selected model omits context budget', async () => {
    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createChatModelByProviderAndModel('p', 'c', { streaming: false });
    expect(result.runtime.contextBudgetTokens).toBe(500_000);
    expect(result.model).toMatchObject({ maxTokens: 128_000 });
  });

  it('uses 500000 for an existing configured model that only omitted context budget', async () => {
    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createChatModelByProviderAndModel('p', 'd', { streaming: false });
    expect(result.runtime.contextBudgetTokens).toBe(500_000);
    expect(result.model).toMatchObject({ temperature: 0.3, maxTokens: 128_000 });
  });
});
