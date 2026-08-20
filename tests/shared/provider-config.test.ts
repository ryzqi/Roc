import { describe, expect, it } from 'vitest';
import { fromTypedProviderConfig, toTypedProviderConfig, type ProviderConfig } from '../../src/shared/types';

function provider(type: ProviderConfig['type'], models: ProviderConfig['models'], options?: ProviderConfig['options']): ProviderConfig {
  return {
    id: `${type}-provider`,
    name: type,
    type,
    endpoint: 'https://provider.example/v1',
    credentialRef: `secret:${type}`,
    enabled: true,
    models,
    options
  };
}

describe('typed provider config helpers', () => {
  it('maps one model option set into typed params and writes it to every model', () => {
    const models = [
      { id: 'fast', displayName: 'Fast', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false },
      { id: 'slow', displayName: 'Slow', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false }
    ];
    const config = provider('openai_compatible', models);
    const typed = toTypedProviderConfig(config, { temperature: 0.2, maxTokens: 4096, reasoning: { effort: 'medium' } });
    expect(typed.params).toMatchObject({ temperature: 0.2, maxTokens: 4096 });
    expect(fromTypedProviderConfig(typed).models.map((model) => model.options)).toEqual([
      { temperature: 0.2, maxTokens: 4096, reasoning: { effort: 'medium' } },
      { temperature: 0.2, maxTokens: 4096, reasoning: { effort: 'medium' } }
    ]);
  });

  it('preserves provider connection options separately', () => {
    const config = provider('openai_compatible', [
      { id: 'model', displayName: 'Model', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false }
    ], { timeoutMs: 30000, defaultHeaders: { 'x-test': 'true' }, organization: 'org' });
    const typed = toTypedProviderConfig(config, {});
    expect(typed.config.options).toEqual(config.options);
    expect(fromTypedProviderConfig(typed).options).toEqual(config.options);
  });
});
