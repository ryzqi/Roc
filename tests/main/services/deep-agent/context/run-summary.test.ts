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
});
