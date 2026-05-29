import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HostIntegrationStatus, PermissionsConfig, ProviderConfig } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';
import { AppBasicsSection } from '../../src/renderer/settings/sections/app-basics-section';
import { AuthSecuritySection } from '../../src/renderer/settings/sections/auth-security-section';
import { BrowserSection } from '../../src/renderer/settings/sections/browser-section';
import { CapabilitiesSection } from '../../src/renderer/settings/sections/capabilities-section';
import { DefaultModelSection } from '../../src/renderer/settings/sections/default-model-section';
import { MemorySection } from '../../src/renderer/settings/sections/memory-section';
import { ProvidersSection } from '../../src/renderer/settings/sections/providers-section';
import { createProviderDraft } from '../../src/renderer/settings-model';

function createPermissions(mode: PermissionsConfig['mode'] = 'fully_automatic'): PermissionsConfig {
  return {
    schemaVersion: 3,
    mode,
    grants: []
  };
}

function createHostStatus(partial?: Partial<HostIntegrationStatus>): HostIntegrationStatus {
  return {
    startup: {
      configuredOpenAtLogin: false,
      effectiveOpenAtLogin: false,
      syncError: null
    },
    globalHotkey: {
      accelerator: null,
      registered: false,
      registrationError: null
    },
    ...partial
  };
}

describe('settings surfaces', () => {
  it('renders settings sections with section headings instead of legacy card titles', () => {
    const settings = createLoadedState({}).settings;
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

    const sectionHtml = [
      renderToStaticMarkup(
        React.createElement(AppBasicsSection, {
          draft: settings,
          hostIntegration: createHostStatus({
            startup: {
              configuredOpenAtLogin: true,
              effectiveOpenAtLogin: true,
              syncError: null
            },
            globalHotkey: {
              accelerator: 'Ctrl+Alt+R',
              registered: false,
              registrationError: '全局快捷键注册失败，请检查是否与系统或其他应用冲突。'
            }
          }),
          onChange: vi.fn()
        })
      ),
      renderToStaticMarkup(
        React.createElement(AuthSecuritySection, {
          draft: createPermissions('default'),
          onChange: vi.fn()
        })
      ),
      renderToStaticMarkup(
        React.createElement(DefaultModelSection, {
          defaultModelId: 'gpt-test',
          onClearDefaultModel: async () => {},
          onSelectDefaultModel: async () => {},
          providers: [provider]
        })
      ),
      renderToStaticMarkup(
        React.createElement(MemorySection, {
          draft: settings,
          onChange: vi.fn()
        })
      ),
      renderToStaticMarkup(
        React.createElement(BrowserSection, {
          exaServer: {
            id: 'exa-hosted',
            name: 'Exa Hosted MCP',
            enabled: false,
            transport: 'http',
            status: 'not_connected',
            tools: 2,
            preset: true,
            riskLevel: 'medium',
            url: 'https://mcp.exa.ai/mcp',
            allowedTools: ['web_search_exa'],
            lastError: null
          },
          onTestExa: async () => {},
          testStatusLabel: '未测试'
        })
      ),
      renderToStaticMarkup(
        React.createElement(CapabilitiesSection, {
          mcpServers: [],
          onNavigate: () => {},
          skills: []
        })
      )
    ].join('\n');

    expect(sectionHtml).toContain('section-title');
    expect(sectionHtml).not.toContain('card-title');
    expect(sectionHtml).toContain('系统实际状态');
    expect(sectionHtml).toContain('已同步');
    expect(sectionHtml).toContain('注册失败');
  });

  it('renders provider rows without status dots or card title chrome', () => {
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
    const providersHtml = renderToStaticMarkup(
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

    expect(providersHtml).not.toContain('provider-status-dot');
    expect(providersHtml).toContain('status-pill');
    expect(providersHtml).toContain('single-panel');
    expect(providersHtml).not.toContain('card-title');
  });
});
