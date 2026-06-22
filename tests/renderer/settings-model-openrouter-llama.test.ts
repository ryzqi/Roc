import { describe, expect, it } from 'vitest';
import {
  buildProviderConfigFromDraft,
  createProviderDraft,
  type ProviderDraft
} from '../../src/renderer/settings/provider-draft-model';
import {
  buildSettingsSaveRequest,
  upsertProviderInSettingsSaveRequest
} from '../../src/renderer/settings/settings-save-model';
import type {
  AppSettings,
  PermissionsConfig,
  ProviderConfig
} from '../../src/shared/types';

function defaultSettings(): AppSettings {
  return {
    schemaVersion: 2,
    defaultWorkspace: null,
    startup: { openAtLogin: false, minimizeToTray: true },
    notifications: { lowDistraction: true },
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


describe('settings model helpers', () => {
  it('builds the fixed OpenRouter provider config without requiring endpoint or model input', () => {
    const draft: ProviderDraft = {
      ...createProviderDraft('openrouter'),
      endpoint: '',
      modelsText: '',
      apiKey: 'sk-or-v1-test'
    };

    expect(buildProviderConfigFromDraft(draft)).toEqual({
      id: 'openrouter',
      name: 'OpenRouter',
      type: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      credentialRef: 'secret:openrouter',
      enabled: true,
      models: [
        {
          id: '~openai/gpt-latest',
          displayName: 'OpenAI GPT Latest',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        },
        {
          id: '~anthropic/claude-sonnet-latest',
          displayName: 'Claude Sonnet Latest',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        },
        {
          id: '~google/gemini-pro-latest',
          displayName: 'Gemini Pro Latest',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: undefined
    });
  });


  it('builds the fixed OpenRouter provider config with configured models and fixed endpoint', () => {
    const draft: ProviderDraft = {
      ...createProviderDraft('openrouter'),
      endpoint: 'https://example.invalid/v1',
      modelsText: 'custom/openrouter-model | Custom OpenRouter model',
      apiKey: 'sk-or-v1-test'
    };

    expect(buildProviderConfigFromDraft(draft)).toEqual({
      id: 'openrouter',
      name: 'OpenRouter',
      type: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      credentialRef: 'secret:openrouter',
      enabled: true,
      models: [
        {
          id: 'custom/openrouter-model',
          displayName: 'Custom OpenRouter model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: undefined
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


  it('replaces a saved llama.cpp provider with a null credentialRef when API key is cleared before save', () => {
    const settings = defaultSettings();
    const permissions = defaultPermissions();
    const request = buildSettingsSaveRequest({
      settings,
      providers: [
        {
          id: 'llama_cpp',
          name: 'llama.cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:8081/v1',
          credentialRef: 'secret:llama_cpp',
          enabled: true,
          models: [
            {
              id: 'Qwen3.5-4B-UD-Q5_K_XL.gguf',
              displayName: 'Qwen 3.5 4B',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ],
      defaultModelId: 'Qwen3.5-4B-UD-Q5_K_XL.gguf',
      permissions
    });

    const savedProvider = buildProviderConfigFromDraft({
      ...createProviderDraft('llama_cpp'),
      endpoint: 'http://127.0.0.1:8081',
      modelsText: 'Qwen3.5-4B-UD-Q5_K_XL.gguf | Qwen 3.5 4B',
      apiKey: ''
    });

    expect(upsertProviderInSettingsSaveRequest(request, savedProvider)).toEqual({
      settings,
      providers: [savedProvider],
      defaultModelId: 'Qwen3.5-4B-UD-Q5_K_XL.gguf',
      permissions
    });
    expect(savedProvider.credentialRef).toBeNull();
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

});

