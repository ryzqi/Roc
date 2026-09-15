import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';

let db: Database.Database;
let repository: ResearchRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db, () => '2026-09-10T00:00:00.000Z');
  repository = new ResearchRepository(db);
});

afterEach(() => db.close());

function project() {
  return repository.createProject({ title: 'Gate', description: 'Human gate checks.', workspacePath: null });
}

describe('research human gate', () => {
  it('rejects complete without stage artifacts and leaves the stage running', async () => {
    const { id } = project();
    const gate = createResearchHumanGate({ repository });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'retrieval' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'start' });
    await expect(gate.complete({ projectId: id, expectedStage: 'retrieval', action: 'complete' }))
      .rejects.toThrow('research_stage_artifact_required');
    expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'retrieval')?.status).toBe('running');
  });

  it('completes a gated stage into waiting_approval and approves it', async () => {
    const { id } = project();
    const gate = createResearchHumanGate({ repository });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'retrieval' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'start' });
    repository.createArtifact({ projectId: id, stage: 'retrieval', kind: 'source_corpus', title: 'Sources', path: null });
    const waiting = await gate.complete({ projectId: id, expectedStage: 'retrieval', action: 'complete' });
    expect(waiting.stages.find((stage) => stage.stage === 'retrieval')).toMatchObject({ status: 'waiting_approval', gateApproved: false });
    const approved = await gate.approve({ projectId: id, expectedStage: 'retrieval', action: 'approve' });
    expect(approved.currentStage).toBe('reading');
    expect(approved.stages.find((stage) => stage.stage === 'retrieval')?.status).toBe('completed');
  });

  it('rejects without verifying production snapshots', async () => {
    const { id } = project();
    const figures = { verifyStage: vi.fn(async () => { throw new Error('should_not_verify'); }) };
    const gate = createResearchHumanGate({ repository, figures });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'retrieval' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'start' });
    repository.createArtifact({ projectId: id, stage: 'retrieval', kind: 'source_corpus', title: 'Sources', path: null });
    await gate.complete({ projectId: id, expectedStage: 'retrieval', action: 'complete' });
    const rejected = await gate.reject({ projectId: id, expectedStage: 'retrieval', action: 'reject', note: 'Add sources.' });
    expect(rejected.stages.find((stage) => stage.stage === 'retrieval')?.status).toBe('running');
    expect(figures.verifyStage).not.toHaveBeenCalled();
  });

  it('does not verify figures outside the figure stage', async () => {
    const { id } = project();
    const figures = { verifyStage: vi.fn(async () => undefined) };
    const gate = createResearchHumanGate({ repository, figures });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'retrieval' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'start' });
    repository.createArtifact({ projectId: id, stage: 'retrieval', kind: 'source_corpus', title: 'Sources', path: null });
    await gate.complete({ projectId: id, expectedStage: 'retrieval', action: 'complete' });
    expect(figures.verifyStage).not.toHaveBeenCalled();
  });
});
