import { describe, expect, it } from 'vitest';
import {
  fromTypedProviderConfig,
  toTypedProviderConfig,
  type ProviderConfig,
  type ProviderConfigTyped
} from '../../src/shared/types';

function provider(input: Partial<ProviderConfig> & Pick<ProviderConfig, 'type'>): ProviderConfig {
  return {
    id: input.id ?? `${input.type}-provider`,
    name: input.name ?? input.type,
    type: input.type,
    endpoint: input.endpoint ?? 'https://provider.example/v1',
    credentialRef: input.credentialRef ?? `secret:${input.type}`,
    enabled: input.enabled ?? true,
    models: input.models ?? [
      {
        id: `${input.type}-model`,
        displayName: `${input.type} model`,
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true
      }
    ],
    options: input.options
  };
}

describe('typed provider config helpers', () => {
  it('round-trips OpenAI-compatible options through persisted option keys', () => {
    const legacy = provider({
      type: 'openai_compatible',
      options: {
        temperature: 0.2,
        maxTokens: 4096,
        topP: 0.9,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        seed: 42,
        stop: ['</done>'],
        timeoutMs: 30_000,
        defaultHeaders: { 'x-provider': 'openai' },
        organization: 'org_123',
        parallelToolCalls: false,
        streamUsage: true,
        serviceTier: 'flex',
        verbosity: 'high',
        zdrEnabled: true,
        useResponsesApi: true,
        reasoning: { effort: 'medium', summary: 'concise' }
      }
    });

    const typed = toTypedProviderConfig(legacy);

    expect(typed.type).toBe('openai_compatible');
    expect(typed.params).toEqual(legacy.options);
    expect(fromTypedProviderConfig(typed)).toEqual(legacy);
  });

  it('maps Anthropic persisted keys to typed names and back to persisted keys', () => {
    const legacy = provider({
      type: 'anthropic_compatible',
      options: {
        temperature: 0.3,
        maxTokens: 8192,
        topP: 0.8,
        topK: 40,
        timeoutMs: 45_000,
        defaultHeaders: { 'x-provider': 'anthropic' },
        stop: ['Human:'],
        anthropicThinking: { mode: 'enabled', budgetTokens: 2048 },
        anthropicBetas: ['prompt-caching-2024-07-31'],
        invocationKwargs: { extra_body: { trace: true } }
      }
    });

    const typed = toTypedProviderConfig(legacy);

    expect(typed.type).toBe('anthropic_compatible');
    expect(typed.params).toEqual({
      temperature: 0.3,
      maxTokens: 8192,
      topP: 0.8,
      topK: 40,
      timeoutMs: 45_000,
      defaultHeaders: { 'x-provider': 'anthropic' },
      stopSequences: ['Human:'],
      thinking: { mode: 'enabled', budgetTokens: 2048 },
      betas: ['prompt-caching-2024-07-31'],
      invocationKwargs: { extra_body: { trace: true } }
    });
    expect(fromTypedProviderConfig(typed).options).toEqual(legacy.options);
  });

  it('keeps NVIDIA options isolated from OpenAI and Anthropic typed params', () => {
    const legacy = provider({
      type: 'nvidia',
      options: {
        temperature: 0.4,
        maxTokens: 2048,
        topP: 0.7,
        topK: 20,
        minP: 0.05,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        repetitionPenalty: 1.1,
        seed: 7,
        stop: ['</tool>'],
        timeoutMs: 60_000,
        defaultHeaders: { 'x-provider': 'nvidia' },
        thinking: true,
        includeReasoning: false,
        parallelToolCalls: true,
        streamUsage: true,
        toolChoice: 'auto',
        guidedJson: { type: 'object' },
        guidedRegex: '^ok$',
        guidedChoice: ['ok'],
        guidedGrammar: 'root ::= "ok"',
        endpointOverride: 'https://integrate.api.nvidia.com/v1'
      }
    });

    const typed = toTypedProviderConfig(legacy);

    expect(typed.type).toBe('nvidia');
    expect(typed.params).toEqual(legacy.options);
    expect(fromTypedProviderConfig(typed)).toEqual(legacy);
  });

  it('uses empty OpenRouter params and discards advanced options on typed write-back', () => {
    const legacy = provider({
      id: 'openrouter',
      type: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      options: {
        temperature: 0.9,
        defaultHeaders: { 'x-should-not-persist': 'true' },
        reasoning: { effort: 'high' },
        serviceTier: 'priority'
      }
    });

    const typed = toTypedProviderConfig(legacy);

    expect(typed).toMatchObject({
      type: 'openrouter',
      params: {}
    });
    expect(fromTypedProviderConfig(typed)).toEqual({
      ...legacy,
      options: {}
    });
  });

  it('models llama.cpp params separately from OpenAI-compatible params', () => {
    const legacy = provider({
      id: 'llama_cpp',
      type: 'llama_cpp',
      endpoint: 'http://127.0.0.1:8080/v1',
      credentialRef: null,
      options: {
        temperature: 0.6,
        maxTokens: 1024,
        topP: 0.85,
        topK: 30,
        minP: 0.04,
        presencePenalty: 0.1,
        repetitionPenalty: 1.05,
        timeoutMs: 120_000,
        defaultHeaders: { 'x-local': 'true' },
        samplingProfileOverrides: {
          temperature: 0.6,
          topP: 0.85,
          topK: 30,
          minP: 0.04,
          presencePenalty: 0.1,
          repeatPenalty: 1.05
        },
        contextBudgetTokens: 12_288,
        reasoning: { effort: 'high' },
        organization: 'must-not-survive',
        serviceTier: 'scale',
        zdrEnabled: true
      }
    });

    const typed = toTypedProviderConfig(legacy);

    expect(typed.type).toBe('llama_cpp');
    expect(typed.params).toEqual({
      temperature: 0.6,
      maxTokens: 1024,
      topP: 0.85,
      topK: 30,
      minP: 0.04,
      presencePenalty: 0.1,
      repetitionPenalty: 1.05,
      timeoutMs: 120_000,
      defaultHeaders: { 'x-local': 'true' },
      samplingProfileOverrides: {
        temperature: 0.6,
        topP: 0.85,
        topK: 30,
        minP: 0.04,
        presencePenalty: 0.1,
        repeatPenalty: 1.05
      },
      contextBudgetTokens: 12_288
    });
    expect(fromTypedProviderConfig(typed).options).toEqual({
      temperature: 0.6,
      maxTokens: 1024,
      topP: 0.85,
      topK: 30,
      minP: 0.04,
      presencePenalty: 0.1,
      repetitionPenalty: 1.05,
      timeoutMs: 120_000,
      defaultHeaders: { 'x-local': 'true' },
      samplingProfileOverrides: {
        temperature: 0.6,
        topP: 0.85,
        topK: 30,
        minP: 0.04,
        presencePenalty: 0.1,
        repeatPenalty: 1.05
      },
      contextBudgetTokens: 12_288
    });
  });

  it.each(['ollama', 'custom'] as const)('rejects unsupported provider type %s', (type) => {
    expect(() => toTypedProviderConfig(provider({ type }))).toThrow(
      `Provider type ${type} does not support typed provider config.`
    );
  });

  it('accepts only empty params for OpenRouter typed config at compile-time boundary', () => {
    const typed = {
      type: 'openrouter',
      config: provider({ id: 'openrouter', type: 'openrouter' }),
      params: {}
    } satisfies ProviderConfigTyped;

    expect(fromTypedProviderConfig(typed).options).toEqual({});
  });
});
