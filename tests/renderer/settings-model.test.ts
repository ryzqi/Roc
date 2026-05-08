import { describe, expect, it } from 'vitest';
import type {
  AppSettings,
  McpServerSnapshot,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  SkillSnapshot
} from '../../src/shared/types';
import {
  applySettingsSnapshot,
  buildImpactRows,
  assertProviderCreateIdAvailable,
  buildSettingsSaveRequest,
  buildEnabledModelOptions,
  buildProviderIdFromName,
  buildProviderConfigFromDraft,
  createProviderDraft,
  deleteProviderFromSettingsSaveRequest,
  parseProviderModelDraft,
  setDefaultModelInSettingsSaveRequest,
  selectSettingsSection,
  SETTINGS_SECTIONS,
  providerTypeMeta,
  upsertProviderInSettingsSaveRequest
} from '../../src/renderer/settings-model';

function defaultSettings(): AppSettings {
  return {
    schemaVersion: 2,
    defaultWorkspace: null,
    startup: { openAtLogin: false, minimizeToTray: true },
    notifications: { lowDistraction: true },
    globalHotkey: null,
    memory: {
      candidateReviewMode: 'manual',
      warmRecallEnabled: true,
      sessionRetentionDays: 90,
      crossScopeRecall: 'explicit_only',
      coldAutoForgetDays: 90
    }
  };
}

function defaultPermissions(): PermissionsConfig {
  return {
    schemaVersion: 2,
    defaultConfirmations: {
      workspaceOutsideWrite: 'always_confirm',
      gitPush: 'always_confirm',
      memoryDelete: 'always_confirm',
      workspaceOutsideShell: 'always_confirm'
    },
    grants: []
  };
}

describe('settings model helpers', () => {
  it('switches only to known settings sections', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
      '模型提供商',
      '默认模型',
      '应用基础',
      '授权与安全',
      '记忆策略',
      '网页与浏览器',
      '能力入口'
    ]);
    expect(selectSettingsSection('providers', 'memory')).toBe('memory');
    expect(selectSettingsSection('providers', 'unknown')).toBe('providers');
  });

  it('creates provider drafts without exposing credential reference fields', () => {
    expect(createProviderDraft('openai_compatible')).toEqual({
      mode: 'create',
      id: '',
      name: '',
      type: 'openai_compatible',
      endpoint: '',
      enabled: true,
      modelsText: ''
    });
    expect(createProviderDraft('anthropic_compatible')).toMatchObject({
      mode: 'create',
      type: 'anthropic_compatible',
      enabled: true
    });
  });

  it('builds deterministic provider ids from provider names', () => {
    expect(buildProviderIdFromName(' Smoke UI OpenAI ')).toBe('smoke-ui-openai');
    expect(buildProviderIdFromName('Anthropic-Compatible / East')).toBe('anthropic-compatible-east');
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

  it('builds provider config from create drafts and derives a safeStorage credential reference', () => {
    const draft = {
      ...createProviderDraft('anthropic_compatible'),
      name: 'Anthropic East',
      endpoint: 'https://anthropic.example.test/v1',
      modelsText: 'claude-sonnet-4-5 | Claude Sonnet 4.5'
    };

    expect(buildProviderConfigFromDraft(draft)).toEqual({
      id: 'anthropic-east',
      name: 'Anthropic East',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic.example.test/v1',
      credentialRef: 'secret:anthropic-east',
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

  it('keeps the existing provider id when editing a saved provider', () => {
    const provider: ProviderConfig = {
      id: 'anthropic-east',
      name: 'Anthropic East',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic.example.test/v1',
      credentialRef: 'secret:anthropic-east',
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
    };

    expect(buildProviderConfigFromDraft(createProviderDraft('anthropic_compatible', provider))).toEqual(provider);
  });

  it('rejects provider drafts whose names cannot produce a valid id', () => {
    const draft = {
      ...createProviderDraft('openai_compatible'),
      name: '!!!',
      endpoint: 'https://openai.example.test/v1',
      modelsText: 'gpt-x | GPT X'
    };
    expect(() => buildProviderConfigFromDraft(draft)).toThrow('Provider 名称');
  });

  it('rejects create-mode provider ids that would collide with an existing provider', () => {
    expect(() =>
      assertProviderCreateIdAvailable(
        [
          {
            id: 'Smoke-UI-OpenAI',
            name: 'Existing Provider',
            type: 'openai_compatible',
            endpoint: 'https://existing.example.test/v1',
            credentialRef: 'secret:Smoke-UI-OpenAI',
            enabled: true,
            models: [
              {
                id: 'existing-model',
                displayName: 'Existing Model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ],
        'smoke-ui-openai'
      )
    ).toThrow('ID 已存在');
  });

  it('lists default-model choices from enabled providers and enabled models only', () => {
    const providers: ProviderConfig[] = [
      {
        id: 'openai-a',
        name: 'OpenAI A',
        type: 'openai_compatible',
        endpoint: 'https://openai-a.example.test/v1',
        credentialRef: 'secret:openai-a',
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
        credentialRef: 'secret:anthropic-disabled',
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

  it('builds and updates a unified settings save request that includes permissions', () => {
    const settings = defaultSettings();
    const permissions = defaultPermissions();
    const firstProvider: ProviderConfig = {
      id: 'openai-a',
      name: 'OpenAI A',
      type: 'openai_compatible',
      endpoint: 'https://openai-a.example.test/v1',
      credentialRef: 'secret:openai-a',
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
      credentialRef: 'secret:anthropic-a',
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
      defaultModelId: 'gpt-a',
      permissions
    });
    const withSecondProvider = upsertProviderInSettingsSaveRequest(draft, secondProvider);
    const changedDefaultModel = setDefaultModelInSettingsSaveRequest(withSecondProvider, 'claude-a');
    const afterDelete = deleteProviderFromSettingsSaveRequest(changedDefaultModel, secondProvider.id);

    expect(draft).toEqual({
      settings,
      providers: [firstProvider],
      defaultModelId: 'gpt-a',
      permissions
    });
    expect(withSecondProvider.providers.map((provider) => provider.id)).toEqual(['openai-a', 'anthropic-a']);
    expect(changedDefaultModel.defaultModelId).toBe('claude-a');
    expect(afterDelete).toEqual({
      settings,
      providers: [firstProvider],
      defaultModelId: null,
      permissions
    });
  });

  it('applies unified settings snapshot into renderer state and clears transient checks', () => {
    const settings: AppSettings = {
      ...defaultSettings(),
      defaultWorkspace: 'F:\\Code\\Roc',
      startup: { openAtLogin: true, minimizeToTray: false },
      notifications: { lowDistraction: false }
    };
    const provider: ProviderConfig = {
      id: 'openai-a',
      name: 'OpenAI A',
      type: 'openai_compatible',
      endpoint: 'https://openai-a.example.test/v1',
      credentialRef: 'secret:openai-a',
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
    const providerSecretStatus: ProviderSecretStatus[] = [{ providerId: 'openai-a', stored: true }];
    const permissions = defaultPermissions();

    expect(
      applySettingsSnapshot({
        settings,
        providers: [provider],
        defaultModelId: 'gpt-a',
        providerSecretStatus,
        permissions,
        mcpServers,
        skills
      })
    ).toEqual({
      settings,
      providers: [provider],
      defaultModelId: 'gpt-a',
      providerSecretStatus,
      permissions,
      mcpServers,
      skills,
      providerTestStatus: null,
      mcpTestStatus: null
    });
  });

  it('reports impact rows for high-impact and routine settings changes', () => {
    const baseSettings = defaultSettings();
    const draftSettings: AppSettings = {
      ...baseSettings,
      defaultWorkspace: 'F:\\Code\\Roc',
      memory: {
        ...baseSettings.memory,
        warmRecallEnabled: false,
        sessionRetentionDays: 30
      }
    };
    const basePermissions = defaultPermissions();
    const draftPermissions: PermissionsConfig = {
      ...basePermissions,
      defaultConfirmations: {
        ...basePermissions.defaultConfirmations,
        gitPush: 'never_confirm'
      }
    };

    const rows = buildImpactRows(
      { settings: baseSettings, permissions: basePermissions, defaultModelId: null },
      { settings: draftSettings, permissions: draftPermissions, defaultModelId: 'model-y' }
    );

    expect(rows.map((row) => row.field)).toEqual([
      'defaultModelId',
      'defaultWorkspace',
      'memory.warmRecallEnabled',
      'memory.sessionRetentionDays',
      'defaultConfirmations.gitPush'
    ]);
    expect(rows.find((row) => row.field === 'defaultModelId')?.severity).toBe('high');
    expect(rows.find((row) => row.field === 'defaultWorkspace')?.severity).toBe('info');
    expect(rows.find((row) => row.field === 'memory.warmRecallEnabled')?.after).toBe('已关闭');
    expect(rows.find((row) => row.field === 'defaultConfirmations.gitPush')?.severity).toBe('high');
  });

  it('providerTypeMeta returns OpenAI defaults for openai_compatible', () => {
    const meta = providerTypeMeta('openai_compatible');
    expect(meta.subtitle).toContain('OpenAI');
    expect(meta.defaultBaseUrl).toBe('https://api.openai.com/v1');
  });

  it('providerTypeMeta returns Anthropic defaults for anthropic_compatible', () => {
    const meta = providerTypeMeta('anthropic_compatible');
    expect(meta.subtitle).toContain('Anthropic');
    expect(meta.defaultBaseUrl).toBe('https://api.anthropic.com');
  });
});
