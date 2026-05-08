import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProvidersSection } from '../../src/renderer/settings/sections/providers-section';
import { createProviderDraft } from '../../src/renderer/settings-model';

describe('providers section', () => {
  it('uses a single add button and exposes in-form provider type choices for new drafts', () => {
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
    expect(html).not.toContain('data-testid="provider-draft-id"');
    expect(html).not.toContain('Get your API key from');
  });
});
