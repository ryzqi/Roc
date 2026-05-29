import { describe, expect, it } from 'vitest';
import { ROC_WORKFLOWS } from '../../../../src/main/services/forge-guardrails/prerequisites-config';
import { resolveWorkflow } from '../../../../src/main/services/forge-guardrails/workflow-resolver';

describe('forge workflow resolver', () => {
  it('resolves the propose workflow', () => {
    expect(resolveWorkflow('propose_background_task')).toBe(ROC_WORKFLOWS.propose_background_task);
  });

  it('resolves the background task change workflow', () => {
    expect(resolveWorkflow('background_task_change')).toBe(ROC_WORKFLOWS.background_task_change);
  });

  it('returns null without a workflow hint', () => {
    expect(resolveWorkflow(null)).toBeNull();
  });
});
