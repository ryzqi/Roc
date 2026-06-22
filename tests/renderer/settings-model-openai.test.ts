import { describe, expect, it } from 'vitest';
import type {
  AppSettings,
  HostIntegrationStatus,
  McpServerSnapshot,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  SkillSnapshot
} from '../../src/shared/types';
import {
  selectSettingsSection,
  SETTINGS_SECTIONS
} from '../../src/renderer/settings-model';
import {
  assertProviderCreateIdAvailable,
  buildEnabledModelOptions,
  buildProviderConfigFromDraft,
  buildProviderIdFromName,
  createProviderDraft,
  parseProviderModelDraft,
  providerTypeMeta,
  type ProviderDraft
} from '../../src/renderer/settings/provider-draft-model';
import { buildImpactRows } from '../../src/renderer/settings/impact-model';
import {
  applySettingsSnapshot,
  buildSettingsSaveRequest,
  deleteProviderFromSettingsSaveRequest,
  setDefaultModelInSettingsSaveRequest,
  upsertProviderInSettingsSaveRequest
} from '../../src/renderer/settings/settings-save-model';

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

function defaultNvidiaDraftFields() {
  return {
    topP: '',
    topK: '',
    minP: '',
    frequencyPenalty: '',
    presencePenalty: '',
    repetitionPenalty: '',
    seed: '',
    stop: '',
    organization: '',
    useResponsesApi: 'unset',
    openAiReasoningEffort: 'unset',
    openAiReasoningSummary: 'unset',
    includeReasoning: 'unset',
    parallelToolCalls: 'unset',
    streamUsage: 'unset',
    serviceTier: 'unset',
    timeoutMs: '',
    verbosity: 'unset',
    zdrEnabled: 'unset',
    defaultHeaders: '',
    modelKwargs: '',
    anthropicThinkingMode: 'unset',
    anthropicThinkingBudgetTokens: '',
    toolChoice: 'unset',
    toolChoiceFunctionName: '',
    endpointOverride: '',
    guidedJson: '',
    guidedRegex: '',
    guidedChoice: '',
    guidedGrammar: ''
  };
}


describe('settings model helpers', () => {
  it('round-trips OpenAI-compatible advanced options through draft and ProviderConfig', () => {
    const provider: ProviderConfig = {
      id: 'openai-lab',
      name: 'OpenAI Lab',
      type: 'openai_compatible',
      endpoint: 'https://openai.example.test/v1',
      credentialRef: 'secret:openai-lab',
      enabled: true,
      models: [
        {
          id: 'gpt-4.1-mini',
          displayName: 'GPT 4.1 Mini',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: {
        temperature: 0.3,
        maxTokens: 2048,
        topP: 0.75,
        frequencyPenalty: 0.2,
        presencePenalty: 0.1,
        seed: 42,
        stop: ['DONE', 'STOP'],
        organization: 'org-roc',
        useResponsesApi: true,
        reasoning: {
          effort: 'high',
          summary: 'concise'
        },
        streamUsage: false,
        parallelToolCalls: true,
        serviceTier: 'flex',
        timeoutMs: 45_000,
        verbosity: 'low',
        zdrEnabled: true,
        defaultHeaders: {
          'x-client': 'roc',
          'x-trace': 'trace-1'
        },
        modelKwargs: {
          chat_template_kwargs: {
            enable_thinking: true
          }
        }
      } as ProviderConfig['options']
    };

    const draft = createProviderDraft('openai_compatible', provider);

    expect(draft).toMatchObject({
      temperature: '0.3',
      maxTokens: '2048',
      topP: '0.75',
      frequencyPenalty: '0.2',
      presencePenalty: '0.1',
      seed: '42',
      stop: 'DONE\nSTOP',
      organization: 'org-roc',
      useResponsesApi: 'true',
      openAiReasoningEffort: 'high',
      openAiReasoningSummary: 'concise',
      streamUsage: 'false',
      parallelToolCalls: 'true',
      serviceTier: 'flex',
      timeoutMs: '45000',
      verbosity: 'low',
      zdrEnabled: 'true',
      modelKwargs: JSON.stringify(
        {
          chat_template_kwargs: {
            enable_thinking: true
          }
        },
        null,
        2
      ),
      anthropicThinkingMode: 'unset',
      anthropicThinkingBudgetTokens: ''
    });
    expect(draft.defaultHeaders).toContain('"x-client": "roc"');

    expect(buildProviderConfigFromDraft(draft)).toEqual(provider);
  });


  it('builds OpenAI-compatible modelKwargs from JSON draft text', () => {
    const draft: ProviderDraft = {
      ...createProviderDraft('openai_compatible'),
      name: 'OpenAI Thinking Local',
      endpoint: 'http://127.0.0.1:9090/v1',
      modelsText: 'thinking-local | Thinking Local',
      modelKwargs: JSON.stringify({
        chat_template_kwargs: {
          enable_thinking: true
        }
      })
    };

    expect(buildProviderConfigFromDraft(draft).options).toEqual({
      modelKwargs: {
        chat_template_kwargs: {
          enable_thinking: true
        }
      }
    });
  });


  it('round-trips explicit OpenAI-compatible reasoning none through draft and ProviderConfig', () => {
    const provider: ProviderConfig = {
      id: 'openai-reasoning-none',
      name: 'OpenAI Reasoning None',
      type: 'openai_compatible',
      endpoint: 'https://openai.example.test/v1',
      credentialRef: 'secret:openai-reasoning-none',
      enabled: true,
      models: [
        {
          id: 'gpt-5.1',
          displayName: 'GPT 5.1',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: {
        reasoning: {
          effort: 'none'
        }
      }
    };

    const draft = createProviderDraft('openai_compatible', provider);

    expect(draft.openAiReasoningEffort).toBe('none');
    expect(buildProviderConfigFromDraft(draft).options).toMatchObject({
      reasoning: {
        effort: 'none'
      }
    });
  });

});

