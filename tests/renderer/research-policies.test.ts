import { describe, expect, it, vi } from 'vitest';

import { policyToDraft } from '../../src/renderer/views/research/ResearchPolicyPanel';
import { createResearchPolicyProjection } from '../../src/renderer/views/research/research-policies';
import type { ResearchStagePolicy } from '../../src/shared/types';

describe('research policy projection', () => {
  it('saves a stage model override', async () => {
    const policy: ResearchStagePolicy = {
      projectId: 'research_1', stage: 'writing', tier: 'deep', model: { kind: 'app_default' }, maxSteps: 30, timeoutMs: 180000
    };
    const saved: ResearchStagePolicy = {
      ...policy, model: { kind: 'model', providerId: 'openai', modelId: 'gpt-5' }, maxSteps: 40, timeoutMs: 240000
    };
    const adapter = {
      list: vi.fn(async () => [policy]),
      save: vi.fn(async () => saved)
    };
    const projection = createResearchPolicyProjection(adapter);
    projection.setProject('research_1');
    await projection.load();
    projection.setDraft({
      ...policyToDraft(policy),
      modelKind: 'model',
      providerId: 'openai',
      modelId: 'gpt-5',
      maxSteps: '40',
      timeoutMs: '240000'
    });
    await projection.save();
    expect(adapter.save).toHaveBeenCalledWith({
      projectId: 'research_1', stage: 'writing', tier: 'deep',
      model: { kind: 'model', providerId: 'openai', modelId: 'gpt-5' }, maxSteps: 40, timeoutMs: 240000
    });
    expect(projection.getSnapshot().draft.modelId).toBe('gpt-5');
  });
});
