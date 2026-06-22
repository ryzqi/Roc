import { describe, expect, it } from 'vitest';
import {
  buildProviderConfigFromDraft,
  createProviderDraft,
  type ProviderDraft
} from '../../src/renderer/settings/provider-draft-model';
import type {
  ProviderConfig
} from '../../src/shared/types';


describe('settings model helpers', () => {
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
        name: 'Broken OpenAI Model Kwargs',
        endpoint: 'https://openai.example.test/v1',
        modelsText: 'gpt-test | GPT Test',
        modelKwargs: '[]'
      })
    ).toThrow('model_kwargs 必须是合法 JSON 对象。');

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

});

