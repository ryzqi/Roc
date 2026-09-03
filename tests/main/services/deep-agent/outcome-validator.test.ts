import { describe, it, expect } from 'vitest';
import { validateOutcomeConsistency } from '../../../../src/main/services/deep-agent/outcome-validator';

describe('validateOutcomeConsistency', () => {
  it('无任何输出时应返回错误', () => {
    const result = validateOutcomeConsistency({
      assistantChunks: [],
      reasoningChunks: [],
      toolCallsByBlockId: new Map(),
      hookDisplayTexts: [],
      usageAccumulated: false
    });

    expect(result).not.toBeNull();
    expect(result?.code).toBe('agent_run_produced_no_output');
    expect(result?.diagnostics.assistantChunksCount).toBe(0);
    expect(result?.diagnostics.toolCallsCount).toBe(0);
  });

  it('有文本输出时应通过验证', () => {
    const result = validateOutcomeConsistency({
      assistantChunks: ['Hello, world!'],
      reasoningChunks: [],
      toolCallsByBlockId: new Map(),
      hookDisplayTexts: [],
      usageAccumulated: true
    });

    expect(result).toBeNull();
  });

  it('有工具调用时应通过验证', () => {
    const toolCalls = new Map([['block-1', 'read_file']]);
    const result = validateOutcomeConsistency({
      assistantChunks: [],
      reasoningChunks: [],
      toolCallsByBlockId: toolCalls,
      hookDisplayTexts: [],
      usageAccumulated: true
    });

    expect(result).toBeNull();
  });

  it('有推理输出时应通过验证', () => {
    const result = validateOutcomeConsistency({
      assistantChunks: [],
      reasoningChunks: ['Let me think...'],
      toolCallsByBlockId: new Map(),
      hookDisplayTexts: [],
      usageAccumulated: true
    });

    expect(result).toBeNull();
  });

  it('有 hook 输出时应通过验证', () => {
    const result = validateOutcomeConsistency({
      assistantChunks: [],
      reasoningChunks: [],
      toolCallsByBlockId: new Map(),
      hookDisplayTexts: ['Hook output'],
      usageAccumulated: true
    });

    expect(result).toBeNull();
  });

  it('空白文本不应计入输出', () => {
    const result = validateOutcomeConsistency({
      assistantChunks: ['   ', '\n\n'],
      reasoningChunks: ['  '],
      toolCallsByBlockId: new Map(),
      hookDisplayTexts: [],
      usageAccumulated: false
    });

    expect(result).not.toBeNull();
    expect(result?.code).toBe('agent_run_produced_no_output');
  });
});
