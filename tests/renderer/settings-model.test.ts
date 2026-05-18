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
    schemaVersion: 3,
    mode: 'fully_automatic',
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
      apiKey: '',
      enabled: true,
      modelsText: '',
      temperature: '',
      maxTokens: '',
      thinking: false
    });
    expect(createProviderDraft('anthropic_compatible')).toMatchObject({
      mode: 'create',
      apiKey: '',
      type: 'anthropic_compatible',
      enabled: true
    });
    expect(createProviderDraft('nvidia')).toEqual({
      mode: 'edit',
      id: 'nvidia',
      name: 'NVIDIA',
      type: 'nvidia',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      apiKey: '',
      enabled: true,
      modelsText: '',
      temperature: '',
      maxTokens: '',
      thinking: false
    });
    expect(createProviderDraft('llama_cpp')).toEqual({
      mode: 'edit',
      id: 'llama_cpp',
      name: 'llama.cpp',
      type: 'llama_cpp',
      endpoint: 'http://127.0.0.1:8081/v1',
      apiKey: '',
      enabled: true,
      modelsText: '',
      temperature: '',
      maxTokens: '',
      thinking: false
    });
  });

  it('builds NVIDIA drafts from existing enabled model lists', () => {
    const provider: ProviderConfig = {
      id: 'nvidia',
      name: 'Ignored NVIDIA Name',
      type: 'nvidia',
      endpoint: 'https://example.invalid',
      credentialRef: 'secret:custom',
      enabled: false,
      models: [
        {
          id: 'moonshotai/kimi-k2.6',
          displayName: 'Kimi K2.6',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        },
        {
          id: 'meta/llama-3.3-70b-instruct',
          displayName: 'Llama 3.3 70B',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: {
        temperature: 0.2,
        maxTokens: 4096,
        thinking: true
      }
    };

    expect(createProviderDraft('nvidia', provider)).toEqual({
      mode: 'edit',
      id: 'nvidia',
      name: 'NVIDIA',
      type: 'nvidia',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      apiKey: '',
      enabled: false,
      modelsText:
        'moonshotai/kimi-k2.6 | Kimi K2.6\nmeta/llama-3.3-70b-instruct | Llama 3.3 70B',
      temperature: '0.2',
      maxTokens: '4096',
      thinking: true
    });
  });

  it('builds llama.cpp drafts from existing enabled model lists while preserving the saved endpoint', () => {
    const provider: ProviderConfig = {
      id: 'llama_cpp',
      name: 'Ignored llama.cpp Name',
      type: 'llama_cpp',
      endpoint: 'http://127.0.0.1:9090/v1',
      credentialRef: null,
      enabled: false,
      models: [
        {
          id: 'qwen3.5-4b',
          displayName: 'Qwen 3.5 4B',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: {
        temperature: 0.6,
        maxTokens: 4096,
        thinking: true
      }
    };

    expect(createProviderDraft('llama_cpp', provider)).toEqual({
      mode: 'edit',
      id: 'llama_cpp',
      name: 'llama.cpp',
      type: 'llama_cpp',
      endpoint: 'http://127.0.0.1:9090/v1',
      apiKey: '',
      enabled: false,
      modelsText: 'qwen3.5-4b | Qwen 3.5 4B',
      temperature: '',
      maxTokens: '',
      thinking: false
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
      apiKey: 'sk-anthropic-east',
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

  it('builds the fixed NVIDIA provider config from model list text and NVIDIA options', () => {
    const draft = {
      ...createProviderDraft('nvidia'),
      modelsText: 'moonshotai/kimi-k2.6 | Kimi K2.6\nmeta/llama-3.3-70b-instruct',
      apiKey: 'nvapi-test',
      temperature: '0.4',
      maxTokens: '16384',
      thinking: true
    };

    expect(buildProviderConfigFromDraft(draft)).toEqual({
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
        },
        {
          id: 'meta/llama-3.3-70b-instruct',
          displayName: 'meta/llama-3.3-70b-instruct',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: {
        temperature: 0.4,
        maxTokens: 16384,
        thinking: true
      }
    });
  });

  it('builds the fixed llama.cpp provider config from model list text while allowing an empty API key', () => {
    const draft = {
      ...createProviderDraft('llama_cpp'),
      endpoint: 'http://127.0.0.1:9090/v1',
      modelsText: 'qwen3.5-4b | Qwen 3.5 4B',
      apiKey: ''
    };

    expect(buildProviderConfigFromDraft(draft)).toEqual({
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

    expect(createProviderDraft('anthropic_compatible', provider)).toMatchObject({
      mode: 'edit',
      id: 'anthropic-east',
      apiKey: ''
    });
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

  it('clears the default model when saving a disabled provider that owns it', () => {
    const settings = defaultSettings();
    const permissions = defaultPermissions();
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

    const request = buildSettingsSaveRequest({
      settings,
      providers: [provider],
      defaultModelId: 'gpt-a',
      permissions
    });

    expect(
      upsertProviderInSettingsSaveRequest(request, {
        ...provider,
        enabled: false
      })
    ).toEqual({
      settings,
      providers: [
        {
          ...provider,
          enabled: false
        }
      ],
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
      mode: 'default'
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
      'permissions.mode'
    ]);
    expect(rows.find((row) => row.field === 'defaultModelId')?.severity).toBe('high');
    expect(rows.find((row) => row.field === 'defaultWorkspace')?.severity).toBe('info');
    expect(rows.find((row) => row.field === 'memory.warmRecallEnabled')?.after).toBe('已关闭');
    expect(rows.find((row) => row.field === 'permissions.mode')?.severity).toBe('high');
    expect(rows.find((row) => row.field === 'permissions.mode')?.after).toBe('默认(MCP 与删除文件需审批)');
  });

  it('providerTypeMeta returns OpenAI defaults for openai_compatible', () => {
    expect(providerTypeMeta('openai_compatible')).toEqual({
      defaultBaseUrl: 'https://api.openai.com/v1'
    });
  });

  it('providerTypeMeta returns Anthropic defaults for anthropic_compatible', () => {
    expect(providerTypeMeta('anthropic_compatible')).toEqual({
      defaultBaseUrl: 'https://api.anthropic.com'
    });
    expect(providerTypeMeta('llama_cpp')).toEqual({
      defaultBaseUrl: 'http://127.0.0.1:8081/v1'
    });
  });
});
