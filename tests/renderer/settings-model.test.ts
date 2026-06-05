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
      thinking: 'unset',
      ...defaultNvidiaDraftFields()
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
      thinking: 'unset',
      ...defaultNvidiaDraftFields()
    });
    expect(createProviderDraft('openrouter')).toEqual({
      mode: 'edit',
      id: 'openrouter',
      name: 'OpenRouter',
      type: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: '',
      enabled: true,
      modelsText:
        '~openai/gpt-latest | OpenAI GPT Latest\n' +
        '~anthropic/claude-sonnet-latest | Claude Sonnet Latest\n' +
        '~google/gemini-pro-latest | Gemini Pro Latest',
      temperature: '',
      maxTokens: '',
      thinking: 'unset',
      ...defaultNvidiaDraftFields()
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
      thinking: 'unset',
      ...defaultNvidiaDraftFields()
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
      thinking: 'true',
      ...defaultNvidiaDraftFields()
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
      thinking: 'unset',
      ...defaultNvidiaDraftFields()
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
      anthropicThinkingMode: 'unset',
      anthropicThinkingBudgetTokens: ''
    });
    expect(draft.defaultHeaders).toContain('"x-client": "roc"');

    expect(buildProviderConfigFromDraft(draft)).toEqual(provider);
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

  it('round-trips Anthropic-compatible advanced options through draft and ProviderConfig', () => {
    const provider: ProviderConfig = {
      id: 'anthropic-lab',
      name: 'Anthropic Lab',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic.example.test',
      credentialRef: 'secret:anthropic-lab',
      enabled: true,
      models: [
        {
          id: 'claude-sonnet-4-5',
          displayName: 'Claude Sonnet 4.5',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: {
        temperature: 0.1,
        maxTokens: 4096,
        topP: 0.85,
        topK: 12,
        stop: ['anthropic-stop'],
        streamUsage: false,
        timeoutMs: 33_000,
        defaultHeaders: {
          'x-tenant': 'east'
        },
        anthropicThinking: {
          mode: 'enabled',
          budgetTokens: 2048
        }
      }
    };

    const draft = createProviderDraft('anthropic_compatible', provider);

    expect(draft).toMatchObject({
      temperature: '0.1',
      maxTokens: '4096',
      topP: '0.85',
      topK: '12',
      stop: 'anthropic-stop',
      streamUsage: 'false',
      timeoutMs: '33000',
      anthropicThinkingMode: 'enabled',
      anthropicThinkingBudgetTokens: '2048',
      parallelToolCalls: 'unset',
      seed: ''
    });
    expect(draft.defaultHeaders).toContain('"x-tenant": "east"');

    expect(buildProviderConfigFromDraft(draft)).toEqual(provider);
  });

  it('round-trips Anthropic adaptive thinking through draft and ProviderConfig', () => {
    const draft: ProviderDraft = {
      ...createProviderDraft('anthropic_compatible'),
      name: 'Anthropic Adaptive',
      endpoint: 'https://anthropic.example.test',
      modelsText: 'claude-opus-4-6 | Claude Opus 4.6',
      anthropicThinkingMode: 'adaptive'
    };

    expect(buildProviderConfigFromDraft(draft).options).toEqual({
      anthropicThinking: {
        mode: 'adaptive'
      }
    });
  });

  it('round-trips explicit Anthropic disabled thinking through draft and ProviderConfig', () => {
    const provider: ProviderConfig = {
      id: 'anthropic-disabled',
      name: 'Anthropic Disabled',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic.example.test',
      credentialRef: 'secret:anthropic-disabled',
      enabled: true,
      models: [
        {
          id: 'claude-opus-4-6',
          displayName: 'Claude Opus 4.6',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: {
        anthropicThinking: {
          mode: 'disabled'
        }
      }
    };

    const draft = createProviderDraft('anthropic_compatible', provider);

    expect(draft.anthropicThinkingMode).toBe('disabled');
    expect(draft.anthropicThinkingBudgetTokens).toBe('');
    expect(buildProviderConfigFromDraft(draft)).toEqual(provider);
  });

  it('rejects invalid default headers, non-positive timeoutMs, and Anthropic thinking budgets that violate the official contract', () => {
    expect(() =>
      buildProviderConfigFromDraft({
        ...createProviderDraft('openai_compatible'),
        name: 'Broken OpenAI',
        endpoint: 'https://openai.example.test/v1',
        modelsText: 'gpt-test | GPT Test',
        defaultHeaders: '{not-json}'
      })
    ).toThrow('default_headers 必须是合法 JSON 对象。');

    expect(() =>
      buildProviderConfigFromDraft({
        ...createProviderDraft('openai_compatible'),
        name: 'Slow OpenAI',
        endpoint: 'https://openai.example.test/v1',
        modelsText: 'gpt-test | GPT Test',
        timeoutMs: '0'
      })
    ).toThrow('timeoutMs 必须是正整数。');

    expect(() =>
      buildProviderConfigFromDraft({
        ...createProviderDraft('anthropic_compatible'),
        name: 'Thinking Anthropic',
        endpoint: 'https://anthropic.example.test',
        modelsText: 'claude-test | Claude Test',
        anthropicThinkingMode: 'enabled',
        anthropicThinkingBudgetTokens: ''
      })
    ).toThrow('Anthropic thinking budget tokens 不能为空。');

    expect(() =>
      buildProviderConfigFromDraft({
        ...createProviderDraft('anthropic_compatible'),
        name: 'Tiny Thinking Anthropic',
        endpoint: 'https://anthropic.example.test',
        modelsText: 'claude-test | Claude Test',
        anthropicThinkingMode: 'enabled',
        anthropicThinkingBudgetTokens: '1023'
      })
    ).toThrow('Anthropic thinking budget tokens 必须大于等于 1024。');

    expect(() =>
      buildProviderConfigFromDraft({
        ...createProviderDraft('anthropic_compatible'),
        name: 'Oversized Thinking Anthropic',
        endpoint: 'https://anthropic.example.test',
        modelsText: 'claude-test | Claude Test',
        maxTokens: '2048',
        anthropicThinkingMode: 'enabled',
        anthropicThinkingBudgetTokens: '2048'
      })
    ).toThrow('Anthropic thinking budget tokens 必须小于 Max tokens。');
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
        skills,
        hostIntegration: defaultHostIntegration()
      })
    ).toEqual({
      settings,
      providers: [provider],
      defaultModelId: 'gpt-a',
      providerSecretStatus,
      permissions,
      mcpServers,
      skills,
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
        frozenSnapshotEnabled: false,
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
      'memory.frozenSnapshotEnabled',
      'memory.sessionRetentionDays',
      'permissions.mode'
    ]);
    expect(rows.find((row) => row.field === 'defaultModelId')?.severity).toBe('high');
    expect(rows.find((row) => row.field === 'defaultWorkspace')?.severity).toBe('info');
    expect(rows.find((row) => row.field === 'memory.frozenSnapshotEnabled')?.after).toBe('已关闭');
    expect(rows.find((row) => row.field === 'permissions.mode')?.severity).toBe('high');
    expect(rows.find((row) => row.field === 'permissions.mode')?.after).toBe('默认(MCP 与删除文件需审批)');
  });

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
