import { describe, expect, it } from 'vitest';
import {
  applyProviderOverride,
  resolveSamplingProfile
} from '../../../../src/main/services/forge-guardrails/sampling-defaults';

describe('forge sampling defaults', () => {
  it.each([
    ['Qwen3-Coder-480B', { temperature: 0.7, topP: 0.8, topK: 20 }],
    ['Qwen3.5-27B-Instruct', { temperature: 1.0, topP: 0.95, topK: 20 }],
    ['Qwen3-8B-Instruct', { temperature: 0.6, topP: 0.95, topK: 20 }],
    ['Ministral-3-8B-Instruct-2512-Q8_0', { temperature: 0.05 }]
  ] as const)('resolves %s', (modelId, expected) => {
    expect(resolveSamplingProfile(modelId)).toEqual(expected);
  });

  it('returns null for unknown model families', () => {
    expect(resolveSamplingProfile('llama-3.1-70b-instruct')).toBeNull();
  });

  it('overrides only explicitly provided fields', () => {
    expect(applyProviderOverride({ temperature: 0.6, topP: 0.95, topK: 20 }, { temperature: 0.8 })).toEqual({
      temperature: 0.8,
      topP: 0.95,
      topK: 20
    });
  });

  it('treats zero-valued overrides as intentional', () => {
    expect(applyProviderOverride({ temperature: 0.6, topP: 0.95 }, { temperature: 0 })).toEqual({
      temperature: 0,
      topP: 0.95
    });
  });
});
