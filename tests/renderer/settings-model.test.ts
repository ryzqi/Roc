import { describe, expect, it } from 'vitest';
import type { AppSettings, McpServerSnapshot, ProviderConfig, SkillSnapshot } from '../../src/shared/types';
import {
  applySettingsSnapshot,
  buildSettingsSaveRequest,
  buildEnabledModelOptions,
  buildProviderConfigFromDraft,
  createProviderDraft,
  deleteProviderFromSettingsSaveRequest,
  parseProviderModelDraft,
  setDefaultModelInSettingsSaveRequest,
  selectSettingsSection,
  SETTINGS_SECTIONS,
  upsertProviderInSettingsSaveRequest
} from '../../src/renderer/settings-model';

describe('settings model helpers', () => {
  it('switches only to known settings sections', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
      '模型提供商',
      '默认模型',
      '应用基础',
      '授权与安全',
      '记忆策略',
      '网页与浏览器',
      '能力入口',
      '外观与语言'
    ]);
    expect(selectSettingsSection('providers', 'memory')).toBe('memory');
    expect(selectSettingsSection('providers', 'unknown')).toBe('providers');
  });

  it('creates provider drafts for new OpenAI-compatible and Anthropic-compatible providers', () => {
    expect(createProviderDraft('openai_compatible')).toMatchObject({
      mode: 'create',
      id: '',
      name: '',
      type: 'openai_compatible',
      endpoint: '',
      credentialRef: 'env:',
      enabled: true,
      modelsText: ''
    });
    expect(createProviderDraft('anthropic_compatible')).toMatchObject({
      mode: 'create',
      type: 'anthropic_compatible',
      credentialRef: 'env:',
      enabled: true
    });
  });

  it('parses model lines into enabled provider model configs', () => {
    expect(parseProviderModelDraft('gpt-4.1 | GPT 4.1\nclaude-sonnet-4-5')).toEqual([
      {
        id: 'gpt-4.1',
        displayName: 'GPT 4.1',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true
      },
      {
        id: 'claude-sonnet-4-5',
        displayName: 'claude-sonnet-4-5',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true
      }
    ]);
  });

  it('builds provider config from a draft without dropping same-type providers', () => {
    const draft = {
      ...createProviderDraft('anthropic_compatible'),
      id: 'anthropic-east',
      name: 'Anthropic East',
      endpoint: 'https://anthropic.example.test/v1',
      credentialRef: 'env:ANTHROPIC_KEY',
      modelsText: 'claude-sonnet-4-5 | Claude Sonnet 4.5'
    };

    expect(buildProviderConfigFromDraft(draft)).toEqual({
      id: 'anthropic-east',
      name: 'Anthropic East',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic.example.test/v1',
      credentialRef: 'env:ANTHROPIC_KEY',
      enabled: true,
      models: [
        {
          id: 'claude-sonnet-4-5',
          displayName: 'Claude Sonnet 4.5',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
  });

  it('lists default-model choices from enabled providers and enabled models only', () => {
    const providers: ProviderConfig[] = [
      {
        id: 'openai-a',
        name: 'OpenAI A',
        type: 'openai_compatible',
        endpoint: 'https://openai-a.example.test/v1',
        credentialRef: 'env:OPENAI_A_KEY',
        enabled: true,
        models: [
          {
            id: 'gpt-a',
            displayName: 'GPT A',
            enabled: true,
            supportsStreaming: true,
            supportsToolCalls: true
          },
          {
            id: 'gpt-disabled',
            displayName: 'GPT Disabled',
            enabled: false,
            supportsStreaming: true,
            supportsToolCalls: true
          }
        ]
      },
      {
        id: 'anthropic-disabled',
        name: 'Anthropic Disabled',
        type: 'anthropic_compatible',
        endpoint: 'https://anthropic-disabled.example.test/v1',
        credentialRef: 'env:ANTHROPIC_DISABLED_KEY',
        enabled: false,
        models: [
          {
            id: 'claude-disabled-provider',
            displayName: 'Claude Disabled Provider',
            enabled: true,
            supportsStreaming: false,
            supportsToolCalls: false
          }
        ]
      }
    ];

    expect(buildEnabledModelOptions(providers)).toEqual([
      {
        modelId: 'gpt-a',
        providerId: 'openai-a',
        label: 'OpenAI A / GPT A'
      }
    ]);
  });

  it('builds and updates a unified settings save request for provider edits and default-model changes', () => {
    const settings: AppSettings = {
      schemaVersion: 1,
      defaultWorkspace: null,
      startup: {
        openAtLogin: false,
        minimizeToTray: true
      },
      notifications: {
        lowDistraction: true
      },
      appearance: {
        theme: 'light'
      },
      memory: {
        candidateReviewMode: 'manual',
        warmRecallEnabled: true
      }
    };
    const firstProvider: ProviderConfig = {
      id: 'openai-a',
      name: 'OpenAI A',
      type: 'openai_compatible',
      endpoint: 'https://openai-a.example.test/v1',
      credentialRef: 'env:OPENAI_A_KEY',
      enabled: true,
      models: [
        {
          id: 'gpt-a',
          displayName: 'GPT A',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    };
    const secondProvider: ProviderConfig = {
      id: 'anthropic-a',
      name: 'Anthropic A',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic-a.example.test/v1',
      credentialRef: 'env:ANTHROPIC_A_KEY',
      enabled: true,
      models: [
        {
          id: 'claude-a',
          displayName: 'Claude A',
          enabled: true,
          supportsStreaming: false,
          supportsToolCalls: false
        }
      ]
    };

    const draft = buildSettingsSaveRequest({
      settings,
      providers: [firstProvider],
      defaultModelId: 'gpt-a'
    });
    const withSecondProvider = upsertProviderInSettingsSaveRequest(draft, secondProvider);
    const changedDefaultModel = setDefaultModelInSettingsSaveRequest(withSecondProvider, 'claude-a');
    const afterDelete = deleteProviderFromSettingsSaveRequest(changedDefaultModel, secondProvider.id);

    expect(draft).toEqual({
      settings,
      providers: [firstProvider],
      defaultModelId: 'gpt-a'
    });
    expect(withSecondProvider.providers.map((provider) => provider.id)).toEqual(['openai-a', 'anthropic-a']);
    expect(changedDefaultModel.defaultModelId).toBe('claude-a');
    expect(afterDelete).toEqual({
      settings,
      providers: [firstProvider],
      defaultModelId: null
    });
  });

  it('applies unified settings snapshot into renderer state and clears transient checks', () => {
    const settings: AppSettings = {
      schemaVersion: 1,
      defaultWorkspace: 'F:\\Code\\Roc',
      startup: {
        openAtLogin: true,
        minimizeToTray: false
      },
      notifications: {
        lowDistraction: false
      },
      appearance: {
        theme: 'light'
      },
      memory: {
        candidateReviewMode: 'manual',
        warmRecallEnabled: true
      }
    };
    const provider: ProviderConfig = {
      id: 'openai-a',
      name: 'OpenAI A',
      type: 'openai_compatible',
      endpoint: 'https://openai-a.example.test/v1',
      credentialRef: 'env:OPENAI_A_KEY',
      enabled: true,
      models: [
        {
          id: 'gpt-a',
          displayName: 'GPT A',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    };
    const mcpServers: McpServerSnapshot[] = [
      {
        id: 'docs-http',
        name: 'Docs HTTP',
        enabled: true,
        transport: 'http',
        status: 'not_connected',
        tools: 1,
        preset: false,
        riskLevel: 'medium',
        url: 'https://docs.example.test/mcp',
        command: undefined,
        allowedTools: ['search_docs'],
        lastError: null
      }
    ];
    const skills: SkillSnapshot[] = [
      {
        id: 'project-review',
        name: 'Project Review',
        enabled: true,
        path: 'F:\\Code\\Roc\\skills\\project-review',
        description: 'Review current project state',
        status: 'ready',
        lastError: null
      }
    ];

    expect(
      applySettingsSnapshot({
        settings,
        providers: [provider],
        defaultModelId: 'gpt-a',
        mcpServers,
        skills
      })
    ).toEqual({
      settings,
      providers: [provider],
      defaultModelId: 'gpt-a',
      mcpServers,
      skills,
      providerTestStatus: null,
      mcpTestStatus: null
    });
  });
});
