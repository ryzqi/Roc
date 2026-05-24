import { describe, expect, it } from 'vitest';
import {
  nvidiaSupportsThinkingViaSystemPrompt,
  nvidiaThinkingParameterName,
  resolveNvidiaModelFamily
} from '../../src/main/services/nvidia-model-family';

describe('resolveNvidiaModelFamily', () => {
  it.each([
    ['qwen/qwen3-235b-a22b', 'qwen'],
    ['qwen/qwen3.5-397b-a17b', 'qwen'],
    ['qwen/qwen3.6-vlm', 'qwen'],
    ['zai-org/glm-4.5-air', 'glm'],
    ['z-ai/glm4.7', 'glm'],
    ['moonshotai/kimi-k2.5', 'kimi'],
    ['moonshotai/kimi-k2.6', 'kimi'],
    ['ibm/granite-3.3-8b-instruct', 'granite'],
    ['deepseek-ai/deepseek-v3.2', 'deepseek'],
    ['nvidia/llama-3.3-nemotron-super-49b-v1', 'nemotron'],
    ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'nemotron'],
    ['openai/gpt-oss-120b', 'gpt-oss'],
    ['meta/llama-3.3-70b-instruct', 'llama'],
    ['mistralai/Mistral-7B-Instruct-v0.3', 'mistral'],
    ['unknown/model', 'unknown']
  ])('classifies %s as %s', (modelId, expected) => {
    expect(resolveNvidiaModelFamily(modelId)).toBe(expected);
  });
});

describe('nvidiaThinkingParameterName', () => {
  it('returns enable_thinking for qwen and glm families', () => {
    expect(nvidiaThinkingParameterName('qwen')).toBe('enable_thinking');
    expect(nvidiaThinkingParameterName('glm')).toBe('enable_thinking');
  });

  it('returns thinking for kimi and granite families', () => {
    expect(nvidiaThinkingParameterName('kimi')).toBe('thinking');
    expect(nvidiaThinkingParameterName('granite')).toBe('thinking');
  });

  it('returns null for families without chat_template_kwargs thinking switch', () => {
    expect(nvidiaThinkingParameterName('nemotron')).toBeNull();
    expect(nvidiaThinkingParameterName('deepseek')).toBeNull();
    expect(nvidiaThinkingParameterName('gpt-oss')).toBeNull();
    expect(nvidiaThinkingParameterName('llama')).toBeNull();
    expect(nvidiaThinkingParameterName('mistral')).toBeNull();
    expect(nvidiaThinkingParameterName('unknown')).toBeNull();
  });
});

describe('nvidiaSupportsThinkingViaSystemPrompt', () => {
  it('returns true only for nemotron family', () => {
    expect(nvidiaSupportsThinkingViaSystemPrompt('nemotron')).toBe(true);
    expect(nvidiaSupportsThinkingViaSystemPrompt('qwen')).toBe(false);
    expect(nvidiaSupportsThinkingViaSystemPrompt('kimi')).toBe(false);
    expect(nvidiaSupportsThinkingViaSystemPrompt('unknown')).toBe(false);
  });
});
