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
      frozenSnapshotEnabled: true,
      userProfileEnabled: true,
      agentsRulesEnabled: true,
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      consolidatorEnabled: true,
      consolidatorDebounceMinutes: 10,
      consolidatorTargetRatio: 0.85,
      consolidatorDailyQuota: 50,
      preCompactionFlushEnabled: true,
      preCompactionTokenThreshold: 0.85,
      preCompactionContextWindowTokens: 200000,
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
  it('builds the fixed NVIDIA provider config from model list text and NVIDIA options', () => {
    const draft: ProviderDraft = {
      ...createProviderDraft('nvidia'),
      modelsText: 'moonshotai/kimi-k2.6 | Kimi K2.6\nmeta/llama-3.3-70b-instruct',
      apiKey: 'nvapi-test',
      temperature: '0.4',
      maxTokens: '16384',
      thinking: 'true'
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


  it('round-trips NVIDIA advanced options through draft and ProviderConfig', () => {
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
      ],
      options: {
        thinking: true,
        temperature: 0.6,
        maxTokens: 16384,
        topP: 0.95,
        topK: 20,
        minP: 0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        repetitionPenalty: 1.0,
        seed: 42,
        stop: ['<|end|>'],
        includeReasoning: true,
        parallelToolCalls: true,
        streamUsage: true,
        toolChoice: {
          type: 'function',
          function: {
            name: 'lookup'
          }
        },
        endpointOverride: 'http://localhost:8000/v1',
        guidedJson: { type: 'object', properties: { name: { type: 'string' } } },
        guidedRegex: '^[A-Z]{3}-\\d{4}$',
        guidedChoice: ['yes', 'no'],
        guidedGrammar: '?start: "ok"'
      }
    };

    const draft = createProviderDraft('nvidia', provider);

    expect(draft).toMatchObject({
      topP: '0.95',
      topK: '20',
      minP: '0',
      seed: '42',
      stop: '<|end|>',
      includeReasoning: 'true',
      parallelToolCalls: 'true',
      streamUsage: 'true',
      thinking: 'true',
      toolChoice: 'function',
      toolChoiceFunctionName: 'lookup',
      endpointOverride: 'http://localhost:8000/v1',
      guidedRegex: '^[A-Z]{3}-\\d{4}$',
      guidedChoice: 'yes\nno',
      guidedGrammar: '?start: "ok"'
    });
    expect(draft.guidedJson).toContain('"type": "object"');

    const rebuilt = buildProviderConfigFromDraft(draft);
    expect(rebuilt.options).toMatchObject(provider.options!);
  });


  it('round-trips explicit NVIDIA thinking false through draft and ProviderConfig', () => {
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
      ],
      options: {
        thinking: false
      }
    };

    const draft = createProviderDraft('nvidia', provider);

    expect(draft.thinking).toBe('false');
    expect(buildProviderConfigFromDraft(draft).options).toMatchObject({
      thinking: false
    });
  });


  it('builds NVIDIA named tool_choice from draft fields', () => {
    const draft: ProviderDraft = {
      ...createProviderDraft('nvidia'),
      modelsText: 'meta/llama-3.3-70b-instruct | Llama 3.3',
      toolChoice: 'function',
      toolChoiceFunctionName: 'lookup'
    };

    expect(buildProviderConfigFromDraft(draft).options).toMatchObject({
      toolChoice: {
        type: 'function',
        function: {
          name: 'lookup'
        }
      }
    });
  });

});

