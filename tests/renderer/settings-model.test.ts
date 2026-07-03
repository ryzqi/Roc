import { describe, expect, it } from 'vitest';
import {
  selectSettingsSection,
  SETTINGS_SECTIONS
} from '../../src/renderer/settings-model';
import {
  buildProviderConfigFromDraft,
  buildProviderIdFromName,
  createProviderDraft,
  parseProviderModelDraft
} from '../../src/renderer/settings/provider-draft-model';
import type {
  ProviderConfig
} from '../../src/shared/types';

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
  it('switches only to known settings sections', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
      '模型提供商',
      '默认模型',
      '应用基础',
      '任务与调度',
      '授权与安全',
      'Hooks',
      '记忆策略'
    ]);
    expect(selectSettingsSection('providers', 'tasks')).toBe('tasks');
    expect(selectSettingsSection('providers', 'browser')).toBe('providers');
    expect(selectSettingsSection('providers', 'capabilities')).toBe('providers');
    expect(selectSettingsSection('providers', 'hooks')).toBe('hooks');
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
        '~openai/gpt-latest | OpenAI GPT Latest | image\n' +
        '~anthropic/claude-sonnet-latest | Claude Sonnet Latest | image\n' +
        '~google/gemini-pro-latest | Gemini Pro Latest | image',
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
          supportsToolCalls: true,
          supportsImages: false
        },
        {
          id: 'meta/llama-3.3-70b-instruct',
          displayName: 'Llama 3.3 70B',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsImages: false
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
          supportsToolCalls: true,
          supportsImages: false
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


  it('builds stable ASCII provider ids while preserving Chinese provider names', () => {
    const firstId = buildProviderIdFromName('硅基流动');
    const secondId = buildProviderIdFromName('硅基流动');

    expect(firstId).toBe(secondId);
    expect(firstId).toMatch(/^provider-[a-f0-9]{8}$/u);

    const draft = {
      ...createProviderDraft('openai_compatible'),
      name: '硅基流动',
      endpoint: 'https://api.siliconflow.cn/v1',
      apiKey: '',
      modelsText: 'Qwen/Qwen3-32B | 通义千问 32B'
    };

    const provider = buildProviderConfigFromDraft(draft);

    expect(provider.name).toBe('硅基流动');
    expect(provider.id).toBe(firstId);
    expect(provider.id).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(provider.credentialRef).toBe(`secret:${firstId}`);
  });


  it('parses model lines into enabled provider model configs', () => {
    expect(parseProviderModelDraft('gpt-4.1 | GPT 4.1\nclaude-sonnet-4-5')).toEqual([
      {
        id: 'gpt-4.1',
        displayName: 'GPT 4.1',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImages: false
      },
      {
        id: 'claude-sonnet-4-5',
        displayName: 'claude-sonnet-4-5',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImages: false
      }
    ]);
  });


  it('parses model image capability metadata from model lines', () => {
    expect(parseProviderModelDraft('gpt-4o | GPT 4o | image\ngpt-4.1 | GPT 4.1 | text')).toEqual([
      {
        id: 'gpt-4o',
        displayName: 'GPT 4o',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImages: true
      },
      {
        id: 'gpt-4.1',
        displayName: 'GPT 4.1',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImages: false
      }
    ]);
  });


  it('rejects model lines outside the current three-column format', () => {
    expect(() => parseProviderModelDraft('gpt-4o | GPT 4o | image | extra')).toThrow(
      'Provider model 格式应为 modelId | displayName | image。'
    );
    expect(() => parseProviderModelDraft('gpt-4o | GPT 4o | vision')).toThrow(
      'Provider model 图片能力仅支持 image 或 text。'
    );
  });


  it('preserves model image capability metadata when editing provider drafts', () => {
    const provider: ProviderConfig = {
      id: 'vision-provider',
      name: 'Vision Provider',
      type: 'openai_compatible',
      endpoint: 'https://vision.example.test/v1',
      credentialRef: 'secret:vision-provider',
      enabled: true,
      models: [
        {
          id: 'gpt-4o',
          displayName: 'GPT 4o',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsImages: true
        },
        {
          id: 'gpt-4.1',
          displayName: 'GPT 4.1',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsImages: false
        }
      ]
    };

    const draft = createProviderDraft('openai_compatible', provider);

    expect(draft.modelsText).toBe('gpt-4o | GPT 4o | image\ngpt-4.1 | GPT 4.1');
    expect(buildProviderConfigFromDraft(draft).models).toEqual(provider.models);
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
          supportsToolCalls: true,
          supportsImages: false
        }
      ]
    });
  });

});
