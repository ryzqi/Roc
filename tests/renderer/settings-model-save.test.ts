import { describe, expect, it } from 'vitest';
import { buildImpactRows } from '../../src/renderer/settings/impact-model';
import {
  assertProviderCreateIdAvailable,
  buildEnabledModelOptions,
  buildProviderConfigFromDraft,
  createProviderDraft
} from '../../src/renderer/settings/provider-draft-model';
import {
  applySettingsSnapshot,
  buildSettingsSaveRequest,
  deleteProviderFromSettingsSaveRequest,
  setDefaultModelInSettingsSaveRequest,
  upsertProviderInSettingsSaveRequest
} from '../../src/renderer/settings/settings-save-model';
import { emptyRocHookConfigSnapshot } from '../../src/shared/types';
import type {
  AppSettings,
  HostIntegrationStatus,
  McpServerSnapshot,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  SkillSnapshot
} from '../../src/shared/types';

function defaultSettings(): AppSettings {
  return {
    schemaVersion: 2,
    defaultWorkspace: null,
    startup: { openAtLogin: false, minimizeToTray: true },
    globalHotkey: null,
    memory: {
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      securityScan: {
        promptInjection: true,
        credential: true,
        sshBackdoor: true,
        invisibleUnicode: true
      }
    },
    tasks: {
      longRunningThresholds: {
        runningSeconds: 90,
        toolCallCount: 8,
        subagentCount: 1
      },
      scheduler: {
        catchUpOnStartup: true,
        maxRegisteredTasks: 256
      }
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

function defaultHostIntegration(): HostIntegrationStatus {
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
    }
  };
}


describe('settings model helpers', () => {
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
                supportsToolCalls: true,
                supportsImages: false
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
            supportsToolCalls: true,
            supportsImages: false
          },
          {
            id: 'gpt-disabled',
            displayName: 'GPT Disabled',
            enabled: false,
            supportsStreaming: true,
            supportsToolCalls: true,
            supportsImages: false
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
            supportsToolCalls: false,
            supportsImages: false
          }
        ]
      }
    ];

    expect(buildEnabledModelOptions(providers)).toEqual([
      {
        modelKey: 'openai-a:gpt-a',
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
          supportsToolCalls: true,
          supportsImages: false
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
          supportsToolCalls: false,
          supportsImages: false
        }
      ]
    };

    const draft = buildSettingsSaveRequest({
      settings,
      providers: [firstProvider],
      defaultModelId: 'openai-a:gpt-a',
      permissions
    });
    const withSecondProvider = upsertProviderInSettingsSaveRequest(draft, secondProvider);
    const changedDefaultModel = setDefaultModelInSettingsSaveRequest(withSecondProvider, 'anthropic-a:claude-a');
    const afterDelete = deleteProviderFromSettingsSaveRequest(changedDefaultModel, secondProvider.id);

    expect(draft).toEqual({
      settings,
      providers: [firstProvider],
      defaultModelId: 'openai-a:gpt-a',
      permissions
    });
    expect(withSecondProvider.providers.map((provider) => provider.id)).toEqual(['openai-a', 'anthropic-a']);
    expect(changedDefaultModel.defaultModelId).toBe('anthropic-a:claude-a');
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
          supportsToolCalls: true,
          supportsImages: false
        }
      ]
    };

    const request = buildSettingsSaveRequest({
      settings,
      providers: [provider],
      defaultModelId: 'openai-a:gpt-a',
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
      startup: { openAtLogin: true, minimizeToTray: false }
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
          supportsToolCalls: true,
          supportsImages: false
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
        defaultModelId: 'openai-a:gpt-a',
        providerSecretStatus,
        permissions,
        mcpServers,
        skills,
        hooks: emptyRocHookConfigSnapshot,
        hostIntegration: defaultHostIntegration()
      })
    ).toEqual({
      settings,
      providers: [provider],
      defaultModelId: 'openai-a:gpt-a',
      providerSecretStatus,
      permissions,
      mcpServers,
      skills,
      hookSettings: emptyRocHookConfigSnapshot,
      hostIntegration: defaultHostIntegration(),
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
        charLimits: {
          ...baseSettings.memory.charLimits,
          memory: 4400
        },
        sessionRetentionDays: 30,
        securityScan: {
          ...baseSettings.memory.securityScan,
          credential: false
        }
      },
      tasks: {
        ...baseSettings.tasks,
        scheduler: {
          ...baseSettings.tasks.scheduler,
          maxRegisteredTasks: 128
        }
      }
    };
    const basePermissions = defaultPermissions();
    const draftPermissions: PermissionsConfig = {
      ...basePermissions,
      mode: 'default'
    };

    const rows = buildImpactRows(
      { settings: baseSettings, permissions: basePermissions, defaultModelId: null },
      { settings: draftSettings, permissions: draftPermissions, defaultModelId: 'provider-y:model-y' }
    );

    expect(rows.map((row) => row.field)).toEqual([
      'defaultModelId',
      'defaultWorkspace',
      'tasks.scheduler.maxRegisteredTasks',
      'memory.charLimits.memory',
      'memory.sessionRetentionDays',
      'memory.securityScan.credential',
      'permissions.mode'
    ]);
    expect(rows.find((row) => row.field === 'defaultModelId')?.severity).toBe('high');
    expect(rows.find((row) => row.field === 'defaultWorkspace')?.severity).toBe('info');
    expect(rows.find((row) => row.field === 'tasks.scheduler.maxRegisteredTasks')?.sectionId).toBe('tasks');
    expect(rows.find((row) => row.field === 'tasks.scheduler.maxRegisteredTasks')?.after).toBe('128 个');
    expect(rows.find((row) => row.field === 'memory.charLimits.memory')?.impact).toBe(
      '会影响 DeepAgents native memory 写入 MEMORY.md 的容量上限。'
    );
    expect(rows.find((row) => row.field === 'memory.securityScan.credential')?.after).toBe('已关闭');
    expect(rows.find((row) => row.field === 'permissions.mode')?.severity).toBe('high');
    expect(rows.find((row) => row.field === 'permissions.mode')?.after).toBe('默认(MCP 与删除文件需审批)');
  });

});
