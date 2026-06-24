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
          supportsToolCalls: true,
          supportsImages: false
        },
        {
          id: 'meta/llama-3.3-70b-instruct',
          displayName: 'meta/llama-3.3-70b-instruct',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsImages: false
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
          supportsToolCalls: true,
          supportsImages: false
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
          supportsToolCalls: true,
          supportsImages: false
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

