import { describe, expect, it } from 'vitest';
import {
  buildEnabledModelOptions,
  buildProviderConfigFromDraft,
  createProviderDraft
} from '../../src/renderer/settings/provider-draft-model';

describe('model-level provider drafts', () => {
  it('serializes card models independently and keeps connection options at provider scope', () => {
    const draft = createProviderDraft('openai_compatible');
    const provider = buildProviderConfigFromDraft({
      ...draft,
      name: 'Local OpenAI',
      endpoint: 'https://example.test/v1',
      timeoutMs: '30000',
      models: [
        { id: 'fast', displayName: 'Fast', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false, options: { temperature: 0.1, maxTokens: 512 } },
        { id: 'reasoning', displayName: 'Reasoning', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false, options: { temperature: 0.8, contextBudgetTokens: 65536 } }
      ]
    });

    expect(provider.options).toEqual({ timeoutMs: 30000 });
    expect(provider.models.map((model) => model.options)).toEqual([
      { temperature: 0.1, maxTokens: 512 },
      { temperature: 0.8, contextBudgetTokens: 65536 }
    ]);
  });

  it('only exposes enabled provider models as default choices', () => {
    const provider = buildProviderConfigFromDraft({
      ...createProviderDraft('openai_compatible'),
      name: 'Provider',
      endpoint: 'https://example.test/v1',
      models: [
        { id: 'enabled', displayName: 'Enabled', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false },
        { id: 'disabled', displayName: 'Disabled', enabled: false, supportsStreaming: true, supportsToolCalls: true, supportsImages: false }
      ]
    });

    expect(buildEnabledModelOptions([provider])).toEqual([
      { modelKey: `${provider.id}:enabled`, modelId: 'enabled', providerId: provider.id, label: 'Provider / Enabled' }
    ]);
  });
});
