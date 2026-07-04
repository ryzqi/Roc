import { describe, expect, it } from 'vitest';

import { buildRunSummary } from '../../../../../src/main/services/deep-agent/context/run-summary';

describe('buildRunSummary', () => {
  it('returns a bounded factual summary from final assistant text', () => {
    const summary = buildRunSummary({
      assistantMessage: 'Implemented workspace scoped session search and verified focused tests.',
      successfulToolNames: ['session_search'],
      workflowHint: null
    });

    expect(summary).toBe('Implemented workspace scoped session search and verified focused tests.');
  });

  it('skips empty output and tool-only noise', () => {
    expect(
      buildRunSummary({
        assistantMessage: '',
        successfulToolNames: ['ls', 'grep'],
        workflowHint: null
      })
    ).toBeNull();
  });

  it('bounds long summaries', () => {
    const summary = buildRunSummary({
      assistantMessage: 'A'.repeat(500),
      successfulToolNames: [],
      workflowHint: null
    });

    expect(summary).toHaveLength(240);
  });

  it('preserves typed automatic memory candidate lines without visible completion text', () => {
    const summary = buildRunSummary({
      assistantMessage: [
        'Completed the implementation.',
        'workspace_fact: roc.memory.pipeline | high | tests/main/services/deep-agent/context/run-summary.test.ts | Auto memory uses typed candidates.',
        'decision: roc.memory.default | high | user confirmed automatic pipeline | Keep automatic memory writes enabled by default.'
      ].join('\n'),
      successfulToolNames: ['read_file'],
      workflowHint: null
    });

    expect(summary).toBe([
      'workspace_fact: roc.memory.pipeline | high | tests/main/services/deep-agent/context/run-summary.test.ts | Auto memory uses typed candidates.',
      'decision: roc.memory.default | high | user confirmed automatic pipeline | Keep automatic memory writes enabled by default.'
    ].join('\n'));
  });

  it('keeps malformed candidate-looking text as a normal summary', () => {
    const summary = buildRunSummary({
      assistantMessage: [
        'Completed the review.',
        'decision: use the smaller implementation path'
      ].join('\n'),
      successfulToolNames: [],
      workflowHint: null
    });

    expect(summary).toBe('Completed the review. decision: use the smaller implementation path');
  });
});
