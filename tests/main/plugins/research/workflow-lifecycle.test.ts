import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { researchWorkflowTransitionRequestSchema } from '../../../../src/shared/schemas/research';

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
  return repository.createProject({ title: 'Workflow', description: 'Persistent research workflow.', workspacePath: null });
}

describe('research workflow lifecycle', () => {
  it('supports entering midway and reopening a stage without reusing old approvals or artifacts', () => {
    const { id } = project();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'retrieval' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'start' });
    const artifact = repository.createArtifact({ projectId: id, stage: 'retrieval', kind: 'source_corpus', title: 'Sources v1', path: null });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'complete' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'approve' });

    const reopened = repository.transitionWorkflow({ projectId: id, expectedStage: 'reading', action: 'move', targetStage: 'retrieval' });
    expect(reopened.currentStage).toBe('retrieval');
    expect(reopened.stages.find((stage) => stage.stage === 'retrieval')).toMatchObject({
      status: 'ready', artifactIds: [], gateApproved: false, completedAt: null, activeRunId: null
    });
    expect(reopened.stages.find((stage) => stage.stage === 'reading')?.status).toBe('locked');
    expect(repository.getArtifact(artifact.id).status).toBe('superseded');
    expect(repository.listArtifacts(id)).toHaveLength(1);
    expect(repository.listWorkflowEvents({ projectId: id, limit: 100 }).map((event) => event.type)).toContain('stage_reopened');

    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'start' });
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'complete' }))
      .toThrow('research_stage_artifact_required');
  });

  it('persists pause and resume while refusing a jump during a running stage or approval', () => {
    const { id } = project();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'start' });
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'writing' }))
      .toThrow('research_stage_cannot_move');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'pause' });
    repository = new ResearchRepository(db);
    expect(repository.getWorkflow(id).projectStatus).toBe('paused');
    expect(repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'resume' }).projectStatus).toBe('active');
  });

  it('rejects edits while an artifact is under review and preserves approved versions', () => {
    const { id } = project();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'retrieval' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'start' });
    const artifact = repository.createArtifact({ projectId: id, stage: 'retrieval', kind: 'source_corpus', title: 'Sources', path: null });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'complete' });
    expect(() => repository.updateArtifact({ id: artifact.id, title: 'Changed during review' })).toThrow('research_stage_not_editable');
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'move', targetStage: 'writing' }))
      .toThrow('research_stage_cannot_move');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'reject', note: 'Add sources.' });
    expect(repository.updateArtifact({ id: artifact.id, title: 'More sources' }).title).toBe('More sources');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'complete' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'retrieval', action: 'approve' });
    expect(() => repository.updateArtifact({ id: artifact.id, title: 'Rewrite approved sources' })).toThrow('research_artifact_immutable');
  });

  it('rolls back artifact creation if linking it to the stage fails', () => {
    const { id } = project();
    db.exec(`CREATE TRIGGER fail_artifact_link BEFORE UPDATE OF artifact_ids_json ON research_stage_states
      BEGIN SELECT RAISE(ABORT, 'link_failed'); END`);
    expect(() => repository.createArtifact({ projectId: id, stage: 'discovery', kind: 'search_strategy', title: 'Atomic', path: null })).toThrow('link_failed');
    expect(repository.listArtifacts(id)).toEqual([]);
    expect(repository.getWorkflow(id).stages[0].artifactIds).toEqual([]);
    expect(repository.listWorkflowEvents({ projectId: id, limit: 100 }).map((event) => event.type)).toEqual(['project_created']);
  });

  it('requires the stage output kind and rejects artifacts for an inactive stage', () => {
    const { id } = project();
    expect(() => repository.createArtifact({ projectId: id, stage: 'discovery', kind: 'manuscript', title: 'Wrong kind', path: null }))
      .toThrow('research_artifact_kind_mismatch');
    expect(() => repository.createArtifact({ projectId: id, stage: 'writing', kind: 'manuscript', title: 'Future stage', path: null }))
      .toThrow('research_artifact_stage_inactive');
  });

  it('rejects provenance that points to an artifact from another project', () => {
    const first = project();
    const second = project();
    const artifact = repository.createArtifact({ projectId: first.id, stage: 'discovery', kind: 'search_strategy', title: 'Owned', path: null });
    expect(() => repository.addProvenance({ projectId: second.id, artifactId: artifact.id, subjectType: 'artifact', subjectId: artifact.id,
      sourceType: 'file', sourceId: 'notes.md', locator: 'line 1', excerpt: 'Evidence' }))
      .toThrow('research_provenance_project_mismatch');
    expect(repository.listProvenance({ projectId: second.id })).toEqual([]);
  });

  it('does not reactivate an archived project through a workflow transition', () => {
    const { id } = project();
    repository.updateProject({ id, status: 'archived' });
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'start' })).toThrow('research_project_archived');
    expect(repository.getProject(id).status).toBe('archived');
  });

  it('validates artifact subjects even when artifactId is null or points to another owned artifact', () => {
    const first = project();
    const second = project();
    const foreign = repository.createArtifact({ projectId: first.id, stage: 'discovery', kind: 'search_strategy', title: 'Foreign', path: null });
    const owned = repository.createArtifact({ projectId: second.id, stage: 'discovery', kind: 'search_strategy', title: 'Owned', path: null });
    for (const artifactId of [null, owned.id]) {
      expect(() => repository.addProvenance({ projectId: second.id, artifactId, subjectType: 'artifact', subjectId: foreign.id,
        sourceType: 'file', sourceId: 'notes.md', locator: 'line 1', excerpt: 'Evidence' }))
        .toThrow('research_provenance_project_mismatch');
    }
    expect(() => repository.addProvenance({ projectId: second.id, artifactId: null, subjectType: 'artifact', subjectId: owned.id,
      sourceType: 'file', sourceId: 'notes.md', locator: 'line 1', excerpt: 'Evidence' }))
      .toThrow('research_provenance_artifact_mismatch');
    expect(repository.listProvenance({ projectId: second.id })).toEqual([]);
  });

  it('validates the destination only for a move request', () => {
    expect(researchWorkflowTransitionRequestSchema.safeParse({ projectId: 'p', expectedStage: 'discovery', action: 'move' }).success).toBe(false);
    expect(researchWorkflowTransitionRequestSchema.safeParse({ projectId: 'p', expectedStage: 'discovery', action: 'start', targetStage: 'writing' }).success).toBe(false);
    expect(researchWorkflowTransitionRequestSchema.safeParse({ projectId: 'p', expectedStage: 'discovery', action: 'move', targetStage: 'writing' }).success).toBe(true);
  });
});
