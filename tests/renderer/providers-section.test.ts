import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../src/shared/types';
import { ProvidersSection } from '../../src/renderer/settings/sections/providers-section';
import { createProviderDraft } from '../../src/renderer/settings/provider-draft-model';

describe('providers section', () => {
  it('uses a single add button, keeps API key inside the create form, and renders icon-only secret toggle', () => {
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
    expect(html).toContain('class="provider-secret-toggle"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).not.toContain('>显示<');
    expect(html).not.toContain('>隐藏<');
    expect(html).not.toContain('data-testid="provider-draft-id"');
    expect(html).not.toContain('data-testid="provider-draft-status"');
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
    expect(html).not.toContain('data-testid="provider-draft-status"');
  });

  it('keeps draft status visible when rendering a provider validation error', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProvidersSection, {
        draft: createProviderDraft('openai_compatible'),
        draftError: 'API Key 是必填项。',
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

    expect(html).toContain('data-testid="provider-draft-status"');
    expect(html).toContain('API Key 是必填项。');
  });

  it('renders fixed NVIDIA details without Fixed chrome and uses the shared model list editor', () => {
    const provider: ProviderConfig = {
      id: 'nvidia',
      name: 'NVIDIA',
      type: 'nvidia',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      credentialRef: 'secret:nvidia',
      enabled: true,
      models: [
        {
          id: 'moonshotai/kimi-k2.6',
          displayName: 'Kimi K2.6',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    };

    const html = renderToStaticMarkup(
      React.createElement(ProvidersSection, {
        draft: createProviderDraft('nvidia', provider),
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

    expect(html).toContain('data-testid="provider-draft-models"');
    expect(html).not.toContain('data-testid="provider-draft-model-id"');
    expect(html).not.toContain('>Fixed<');
    expect(html).toContain('value="https://integrate.api.nvidia.com/v1"');
    expect(html).toContain('readOnly=""');
    expect(html).not.toContain(`data-testid="provider-delete-${provider.id}"`);
  });

  it('renders NVIDIA advanced parameter panel with all NIM fields', () => {
    const provider: ProviderConfig = {
      id: 'nvidia',
      name: 'NVIDIA',
      type: 'nvidia',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      credentialRef: 'secret:nvidia',
      enabled: true,
      models: [
        {
          id: 'qwen/qwen3-235b-a22b',
          displayName: 'Qwen3',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    };
    const html = renderToStaticMarkup(
      React.createElement(ProvidersSection, {
        draft: createProviderDraft('nvidia', provider),
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

    expect(html).toContain('data-testid="provider-draft-top-p"');
    expect(html).toContain('data-testid="provider-draft-top-k"');
    expect(html).toContain('data-testid="provider-draft-min-p"');
    expect(html).toContain('data-testid="provider-draft-frequency-penalty"');
    expect(html).toContain('data-testid="provider-draft-presence-penalty"');
    expect(html).toContain('data-testid="provider-draft-repetition-penalty"');
    expect(html).toContain('data-testid="provider-draft-seed"');
    expect(html).toContain('data-testid="provider-draft-stop"');
    expect(html).toContain('data-testid="provider-draft-include-reasoning"');
    expect(html).toContain('data-testid="provider-draft-parallel-tool-calls"');
    expect(html).toContain('data-testid="provider-draft-stream-usage"');
    expect(html).toContain('data-testid="provider-draft-tool-choice"');
    expect(html).toContain('data-testid="provider-draft-tool-choice-function-name"');
    expect(html).toContain('data-testid="provider-draft-endpoint-override"');
    expect(html).toContain('data-testid="provider-draft-guided-json"');
    expect(html).toContain('data-testid="provider-draft-guided-regex"');
    expect(html).toContain('data-testid="provider-draft-guided-choice"');
    expect(html).toContain('data-testid="provider-draft-guided-grammar"');
  });

  it('renders fixed llama.cpp details with an editable endpoint and without delete controls', () => {
    const provider: ProviderConfig = {
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
    };

    const html = renderToStaticMarkup(
      React.createElement(ProvidersSection, {
        draft: createProviderDraft('llama_cpp', provider),
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
        providerSecretStatus: [],
        providerTestStatus: null,
        secretBusyProviderId: null
      })
    );

    expect(html).toContain('value="http://127.0.0.1:9090/v1"');
    expect(html).not.toContain('readOnly=""');
    expect(html).not.toContain('data-testid="provider-draft-name"');
    expect(html).not.toContain(`data-testid="provider-delete-${provider.id}"`);
  });

  it('shows the last successful provider test result with the tested model id', () => {
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
        providerTestStatus: {
          providerId: provider.id,
          status: 'ready',
          defaultModelReady: false,
          checked: ['id', 'enabled', 'models', 'credentials', 'transport'],
          modelId: 'gpt-test',
          error: null
        },
        secretBusyProviderId: null
      })
    );

    expect(html).toContain('data-testid="provider-test-feedback"');
    expect(html).toContain('已测试 gpt-test 可用。');
  });

  it('shows the last provider test failure reason instead of only changing the status pill', () => {
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
        providerTestStatus: {
          providerId: provider.id,
          status: 'invalid',
          defaultModelReady: false,
          checked: ['id', 'enabled', 'models', 'credentials', 'transport'],
          modelId: 'gpt-test',
          error: 'Provider 请求失败：HTTP 401 [REDACTED]'
        },
        secretBusyProviderId: null
      })
    );

    expect(html).toContain('data-testid="provider-test-feedback"');
    expect(html).toContain('gpt-test 测试失败：Provider 请求失败：HTTP 401 [REDACTED]');
  });
});
