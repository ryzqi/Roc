import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../src/shared/types';
import { ProvidersSection } from '../../src/renderer/settings/sections/providers-section';
import { createProviderDraft } from '../../src/renderer/settings/provider-draft-model';

const provider: ProviderConfig = {
  id: 'provider-openai',
  name: 'Provider OpenAI',
  type: 'openai_compatible',
  endpoint: 'https://api.example.test/v1',
  credentialRef: 'secret:provider-openai',
  enabled: true,
  models: [
    { id: 'fast', displayName: 'Fast', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false, options: { temperature: 0.1 } },
    { id: 'reasoning', displayName: 'Reasoning', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false, options: { temperature: 0.8 } }
  ]
};

function render(providerValue: ProviderConfig = provider): string {
  return renderToStaticMarkup(React.createElement(ProvidersSection, {
    draft: createProviderDraft('openai_compatible', providerValue),
    draftError: null,
    onClearProviderSecret: async () => {},
    onDeleteProvider: async () => {},
    onEditProvider: () => {},
    onSaveProviderDraft: async () => {},
    onStartNewProvider: () => {},
    onTestProvider: async () => {},
    onUpdateDraft: () => {},
    providers: [providerValue],
    providerSecretStatus: [],
    providerTestStatus: null,
    secretBusyProviderId: null
  }));
}

describe('providers section', () => {
  it('renders model cards with independent parameter controls and no provider test button', () => {
    const html = render();
    expect(html).toContain('data-testid="provider-model-card-0"');
    expect(html).toContain('data-testid="provider-model-card-1"');
    expect(html).toContain('data-testid="provider-model-options-fields-0"');
    expect(html).toContain('data-testid="provider-model-options-fields-1"');
    expect(html).not.toContain('provider-test-provider');
    expect(html).not.toContain('provider-draft-models');
    expect(html).not.toContain('provider-draft-temperature');
  });

  it('renders a model test action only on a concrete model card', () => {
    const html = render();
    expect(html).toContain('data-testid="provider-model-test-0"');
    expect(html).toContain('data-testid="provider-model-test-1"');
  });

  it('renders connection fields separately from model fields', () => {
    const html = render();
    expect(html).toContain('default_headers');
    expect(html).toContain('timeout_ms');
    expect(html).not.toContain('provider-draft-model-kwargs');
  });
});
