import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../src/shared/types';
import { ProvidersSection } from '../../src/renderer/settings/sections/providers-section';
import { createProviderDraft } from '../../src/renderer/settings-model';

describe('providers section', () => {
  it('uses a single add button and keeps API key inside the create form', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProvidersSection, {
        draft: createProviderDraft('openai_compatible'),
        draftError: null,
        onClearProviderSecret: async () => {},
        onDeleteProvider: async () => {},
        onEditProvider: () => {},
        onSaveProviderDraft: async () => {},
        onSetProviderSecret: async () => {},
        onStartNewProvider: () => {},
        onTestProvider: async () => {},
        onUpdateDraft: () => {},
        providers: [],
        providerSecretStatus: [],
        providerTestStatus: null,
        secretBusyProviderId: null
      })
    );

    expect(html).toContain('data-testid="provider-add-openai"');
    expect(html).not.toContain('data-testid="provider-add-anthropic"');
    expect(html).toContain('data-testid="provider-draft-type-openai_compatible"');
    expect(html).toContain('data-testid="provider-draft-type-anthropic_compatible"');
    expect(html).toContain('data-testid="provider-draft-api-key"');
    expect(html).not.toContain('data-testid="provider-draft-id"');
    expect(html).not.toContain('OpenAI compatible chat completions endpoint');
    expect(html).not.toContain('Anthropic compatible /messages endpoint');
    expect(html).not.toContain('保存 Provider 后可录入 API Key。');
    expect(html).not.toContain('provider-secret-save-');
    expect(html).not.toContain('Get your API key from');
  });

  it('keeps clear-only secret controls for existing providers while reusing the shared API key input', () => {
    const provider: ProviderConfig = {
      id: 'provider-openai',
      name: 'Provider OpenAI',
      type: 'openai_compatible',
      endpoint: 'https://api.example.test/v1',
      credentialRef: 'secret:provider-openai',
      enabled: true,
      models: [
        {
          id: 'gpt-test',
          displayName: 'GPT Test',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    };
    const html = renderToStaticMarkup(
      React.createElement(ProvidersSection, {
        draft: createProviderDraft('openai_compatible', provider),
        draftError: null,
        onClearProviderSecret: async () => {},
        onDeleteProvider: async () => {},
        onEditProvider: () => {},
        onSaveProviderDraft: async () => {},
        onSetProviderSecret: async () => {},
        onStartNewProvider: () => {},
        onTestProvider: async () => {},
        onUpdateDraft: () => {},
        providers: [provider],
        providerSecretStatus: [{ providerId: provider.id, stored: true }],
        providerTestStatus: null,
        secretBusyProviderId: null
      })
    );

    expect(html).toContain('data-testid="provider-draft-api-key"');
    expect(html).toContain(`data-testid="provider-secret-clear-${provider.id}"`);
    expect(html).not.toContain(`data-testid="provider-secret-save-${provider.id}"`);
  });
});
