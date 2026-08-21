// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
  it('renders a compact searchable model table without expanding every model editor', () => {
    const html = render();
    expect(html).toContain('data-testid="provider-model-table"');
    expect(html).toContain('data-testid="provider-model-row-0"');
    expect(html).toContain('data-testid="provider-model-row-1"');
    expect(html).toContain('data-testid="provider-model-search"');
    expect(html).not.toContain('data-testid="provider-model-options-fields-0"');
    expect(html).not.toContain('provider-test-provider');
    expect(html).not.toContain('provider-draft-models');
    expect(html).not.toContain('provider-draft-temperature');
  });

  it('renders model test actions only on concrete model rows', () => {
    const html = render();
    expect(html.match(/aria-label="测试模型"/g)).toHaveLength(2);
  });

  it('renders connection fields separately from model fields', () => {
    const html = render();
    expect(html).toContain('default_headers');
    expect(html).toContain('timeout_ms');
    expect(html).not.toContain('provider-draft-model-kwargs');
  });

  it('shows model test feedback on the matching row and drawer with advanced options collapsed', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(ProvidersSection, {
        draft: createProviderDraft('openai_compatible', provider),
        draftError: null,
        onClearProviderSecret: async () => {},
        onDeleteProvider: async () => {},
        onEditProvider: () => {},
        onSaveProviderDraft: async () => {},
        onStartNewProvider: () => {},
        onTestProvider: async () => {},
        onUpdateDraft: () => {},
        providers: [provider],
        providerSecretStatus: [],
        providerTestStatus: {
          providerId: provider.id,
          status: 'ready',
          defaultModelReady: true,
          checked: ['fast'],
          modelId: 'fast',
          error: null,
          latencyMs: 18
        },
        secretBusyProviderId: null
      }));
    });

    expect(container.querySelector('[data-testid="provider-model-test-feedback-0"]')?.textContent).toContain('fast');
    expect(container.querySelector('[data-testid="provider-model-test-feedback-1"]')).toBeNull();

    await act(async () => container.querySelector<HTMLElement>('[data-testid="provider-model-open-0"]')?.click());
    expect(container.querySelector('[data-testid="provider-model-drawer-test-feedback"]')?.textContent).toContain('fast');
    expect(container.querySelector<HTMLDetailsElement>('.provider-model-advanced')?.open).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  it('requires confirmation before deleting a provider', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onDeleteProvider = vi.fn(async () => {});
    await act(async () => {
      root.render(React.createElement(ProvidersSection, {
        draft: createProviderDraft('openai_compatible', provider),
        draftError: null,
        onClearProviderSecret: async () => {},
        onDeleteProvider,
        onEditProvider: () => {},
        onSaveProviderDraft: async () => {},
        onStartNewProvider: () => {},
        onTestProvider: async () => {},
        onUpdateDraft: () => {},
        providers: [provider],
        providerSecretStatus: [],
        providerTestStatus: null,
        secretBusyProviderId: null
      }));
    });
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="provider-delete-provider-openai"]')?.click();
    });
    expect(onDeleteProvider).not.toHaveBeenCalled();
    expect(container.textContent).toContain('删除这个提供商？');
    const dialog = container.querySelector('[role="alertdialog"]');
    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent === '删除提供商');
    await act(async () => confirm?.click());
    expect(onDeleteProvider).toHaveBeenCalledWith('provider-openai');
    await act(async () => root.unmount());
    container.remove();
  });
});
