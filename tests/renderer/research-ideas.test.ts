import { describe, expect, it, vi } from 'vitest';

import { canvasToDraft } from '../../src/renderer/views/research/ResearchIdeaPanel';
import { createResearchIdeaProjection } from '../../src/renderer/views/research/research-ideas';
import type { ResearchIdeaCanvas } from '../../src/shared/types';

describe('research idea projection', () => {
  it('saves an idea canvas and promotes the approved version', async () => {
    const canvas: ResearchIdeaCanvas = {
      artifactId: 'artifact_idea', projectId: 'research_1', version: 1, problem: 'How to keep graphs inspectable?', hypothesis: 'Structured canvases help.',
      novelty: 'Promotion keeps versions.', supportingEvidence: 'Prior work lacks records.', counterevidence: '', experiment: 'Promote and inspect origin.',
      risks: 'Stale duplicates.', priority: 'high', rationale: 'Testable path.', contentHash: 'b'.repeat(64),
      createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
      fields: [
        { key: 'problem', content: 'How to keep graphs inspectable?', status: 'pending', evidenceIds: [] },
        { key: 'hypothesis', content: 'Structured canvases help.', status: 'hypothesis', evidenceIds: [] },
        { key: 'novelty', content: 'Promotion keeps versions.', status: 'pending', evidenceIds: [] },
        { key: 'supportingEvidence', content: 'Prior work lacks records.', status: 'pending', evidenceIds: [] },
        { key: 'counterevidence', content: '', status: 'pending', evidenceIds: [] },
        { key: 'experiment', content: 'Promote and inspect origin.', status: 'hypothesis', evidenceIds: [] },
        { key: 'risks', content: 'Stale duplicates.', status: 'pending', evidenceIds: [] }
      ]
    };
    const host = {
      projectId: () => 'research_1',
      currentStage: () => 'ideation',
      stageStatus: () => 'running',
      moveToIdeation: vi.fn(async () => undefined),
      startIdeation: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      selectProject: vi.fn(async () => undefined)
    };
    const adapter = {
      createArtifact: vi.fn(),
      get: vi.fn(async () => canvas),
      save: vi.fn(async () => ({ ...canvas, version: 2, rationale: 'Updated ranking.' })),
      promote: vi.fn(async () => ({ project: { id: 'research_2', title: 'Promoted', description: canvas.problem, workspacePath: '/tmp/research-ideas.test-1', status: 'active' as const, language: 'zh' as const, origin: { projectId: 'research_1', artifactId: canvas.artifactId, version: 1 }, currentStage: 'discovery' as const, createdAt: canvas.createdAt, updatedAt: canvas.updatedAt } }))
    };
    const projection = createResearchIdeaProjection(adapter, host);
    await projection.select(canvas.artifactId);
    projection.setDraft({ ...canvasToDraft(canvas), rationale: 'Updated ranking.' });
    await projection.save();
    expect(adapter.save).toHaveBeenCalled();
    await projection.promote('/tmp/promoted-study');
    expect(adapter.promote).toHaveBeenCalledWith({ artifactId: canvas.artifactId, expectedVersion: 2, workspacePath: '/tmp/promoted-study' });
    expect(host.selectProject).toHaveBeenCalledWith('research_2');
  });
});
