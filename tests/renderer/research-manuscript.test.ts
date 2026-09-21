import { describe, expect, it, vi } from 'vitest';

import { createResearchManuscriptProjection } from '../../src/renderer/views/research/research-manuscript';
import { emptyManuscriptDraft } from '../../src/renderer/views/research/ResearchManuscriptPanel';
import type { ResearchArtifact, ResearchClaim, ResearchManuscript } from '../../src/shared/types';

describe('research manuscript projection', () => {
  it('creates a supported claim and saves the manuscript latex', async () => {
    const artifact: ResearchArtifact = {
      id: 'artifact_1', projectId: 'research_1', stage: 'writing', kind: 'manuscript', title: 'Manuscript',
      path: null, status: 'draft', createdAt: '2026-09-14T00:40:00.000Z', updatedAt: '2026-09-14T00:50:00.000Z'
    };
    const claim: ResearchClaim = {
      id: 'claim_1', projectId: 'research_1', artifactId: artifact.id, subjectType: 'paragraph',
      content: 'The measured result is 42 units.', status: 'supported', evidenceIds: ['evidence_1'],
      version: 1, createdAt: '2026-09-14T01:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z'
    };
    const saved: ResearchManuscript = {
      artifactId: artifact.id, projectId: 'research_1',
      sections: [{ title: 'Results', claimIds: [claim.id] }],
      latex: '\\section{Results}\\nThe measured result is 42 units.',
      contentHash: 'c'.repeat(64), claimsHash: 'd'.repeat(64), updatedAt: claim.createdAt
    };
    const host = {
      projectId: () => 'research_1',
      currentStage: () => 'writing',
      stageStatus: vi.fn(() => 'running'),
      moveToWriting: vi.fn(async () => undefined),
      startWriting: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined)
    };
    const adapter = {
      createArtifact: vi.fn(async () => artifact),
      getManuscript: vi.fn(async () => null),
      listClaims: vi.fn(async () => [claim]),
      createClaim: vi.fn(),
      saveManuscript: vi.fn(async () => saved)
    };
    const projection = createResearchManuscriptProjection(adapter, host);
    await projection.create();
    expect(host.moveToWriting).not.toHaveBeenCalled();
    expect(host.startWriting).not.toHaveBeenCalled();
    expect(adapter.createArtifact).toHaveBeenCalledWith(expect.objectContaining({ stage: 'writing', kind: 'manuscript' }));
    projection.setDraft({
      ...emptyManuscriptDraft,
      content: claim.content,
      status: 'supported',
      evidenceIds: claim.evidenceIds
    });
    await projection.createClaim();
    expect(adapter.createClaim).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: artifact.id, content: claim.content, status: 'supported', evidenceIds: claim.evidenceIds
    }));
    projection.setDraft({
      ...projection.getSnapshot().draft,
      selectedClaimIds: [claim.id]
    });
    await projection.save();
    expect(adapter.saveManuscript).toHaveBeenCalledWith({
      artifactId: artifact.id, sections: [{ title: '结果', claimIds: [claim.id] }]
    });
    expect(projection.getSnapshot().manuscript?.latex).toContain('The measured result is 42 units.');
  });

  it('rejects claim creation without a selected manuscript', async () => {
    const adapter = {
      createArtifact: vi.fn(),
      getManuscript: vi.fn(),
      listClaims: vi.fn(),
      createClaim: vi.fn(),
      saveManuscript: vi.fn()
    };
    const host = {
      projectId: () => 'research_1',
      currentStage: () => 'writing',
      stageStatus: vi.fn(() => 'running'),
      moveToWriting: vi.fn(async () => undefined),
      startWriting: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined)
    };
    const projection = createResearchManuscriptProjection(adapter, host);
    projection.setDraft({
      ...emptyManuscriptDraft,
      content: 'The measured result is 42 units.',
      status: 'supported',
      evidenceIds: ['evidence_1']
    });
    await projection.createClaim();
    expect(adapter.createClaim).not.toHaveBeenCalled();
  });

  it('moves to writing and starts the stage before creating a manuscript', async () => {
    const artifact: ResearchArtifact = {
      id: 'artifact_1', projectId: 'research_1', stage: 'writing', kind: 'manuscript', title: 'Manuscript',
      path: null, status: 'draft', createdAt: '2026-09-14T00:40:00.000Z', updatedAt: '2026-09-14T00:50:00.000Z'
    };
    const host = {
      projectId: () => 'research_1',
      currentStage: vi.fn(() => 'discovery'),
      stageStatus: vi.fn(() => 'ready'),
      moveToWriting: vi.fn(async () => undefined),
      startWriting: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined)
    };
    const adapter = {
      createArtifact: vi.fn(async () => artifact),
      getManuscript: vi.fn(),
      listClaims: vi.fn(),
      createClaim: vi.fn(),
      saveManuscript: vi.fn()
    };
    const projection = createResearchManuscriptProjection(adapter, host);
    await projection.create();
    expect(host.moveToWriting).toHaveBeenCalled();
    expect(host.startWriting).toHaveBeenCalled();
    expect(adapter.createArtifact).toHaveBeenCalled();
  });
});
