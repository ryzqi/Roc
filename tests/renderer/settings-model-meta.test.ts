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
  it('providerTypeMeta returns OpenAI defaults for openai_compatible', () => {
    expect(providerTypeMeta('openai_compatible')).toEqual({
      defaultBaseUrl: 'https://api.openai.com/v1'
    });
    expect(providerTypeMeta('openrouter')).toEqual({
      defaultBaseUrl: 'https://openrouter.ai/api/v1'
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

