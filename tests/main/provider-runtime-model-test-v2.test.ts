import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-provider-test-v2-');
  services.secretService.setProviderSecret('p', 'sk-test');
  services.configService.saveProviders({
    schemaVersion: 2,
    defaultModelId: 'p:a',
    providers: [{
      id: 'p', name: 'Provider', type: 'openai_compatible', endpoint: 'https://example.test/v1', credentialRef: 'secret:p', enabled: true,
      models: [
        { id: 'a', displayName: 'A', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false },
        { id: 'b', displayName: 'B', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false }
      ]
    }]
  });
});

afterEach(async () => {
  await services.cleanup();
});

describe('ProviderRuntimeService model test v2', () => {
  it('tests the requested model instead of the first enabled model', async () => {
    const transport = vi.fn(async (request: { modelId: string }) => ({ content: `ok:${request.modelId}`, finishReason: 'stop' }));
    Reflect.set(services.providerRuntimeService, 'deterministicTransport', transport);
    const result = await services.providerRuntimeService.testProvider({ providerId: 'p', modelId: 'b' });
    expect(result.status).toBe('ready');
    expect(result.modelId).toBe('b');
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'b' }));
  });

  it('returns an explicit invalid result for a missing model', async () => {
    const result = await services.providerRuntimeService.testProvider({ providerId: 'p', modelId: 'missing' });
    expect(result.status).toBe('invalid');
    expect(result.modelId).toBe('missing');
    expect(result.error).toContain('模型');
  });
});
