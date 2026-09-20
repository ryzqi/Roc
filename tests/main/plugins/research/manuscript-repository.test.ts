import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import type { ResearchKnowledgeDocumentUpsertRequest } from '../../../../src/shared/types';

let db: Database.Database;
let repository: ResearchRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
});
afterEach(() => db.close());

function project() {
  return repository.createProject({ title: 'Evidence study', description: 'Test provenance.', workspacePath: null });
}

function document(projectId: string | null, input: Partial<ResearchKnowledgeDocumentUpsertRequest> = {}) {
  repository.knowledge.upsertKnowledgeDocument({
    id: 'paper', projectId, sourceType: 'file', sourceId: 'paper.pdf', title: 'Published result',
    content: '  Measured improvement: 20%.  ', chunks: [{ content: '  Measured improvement: 20%.  ', locator: 'page 4, paragraph 2' }],
    embeddingConfigId: null, ...input
  });
}

function manuscriptProject() {
  const { id } = project();
  repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'writing' });
  repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'start' });
  const artifact = repository.createArtifact({ projectId: id, stage: 'writing', kind: 'manuscript', title: 'Results', path: null });
  document(id);
  const evidence = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
  return { id, artifact, evidence };
}

describe('research manuscript save and export boundaries', () => {
  it('keeps a hypothesis as a draft and blocks its inclusion in manuscript prose', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Improvement may reach 20%.', status: 'hypothesis', evidenceIds: [] });
    const request = { artifactId: artifact.id, sections: [{ title: 'Results & analysis', claimIds: [claim.id] }] };
    expect(() => repository.manuscripts.saveManuscript(request)).toThrow('research_claim_unverified');
    expect(repository.manuscripts.getManuscript(artifact.id)).toBeNull();
    repository.evidence.updateClaim({ id: claim.id, expectedVersion: claim.version, content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidence.id] });
    const manuscript = repository.manuscripts.saveManuscript(request);
    expect(manuscript.latex).toContain('Results \\& analysis');
    expect(manuscript.latex).toContain('Measured improvement: 20\\%.');
    expect(manuscript.latex).toContain(`\\cite{${evidence.id}}`);
    expect(manuscript.latex).toContain('page 4, paragraph 2');
    expect(repository.listProvenance({ projectId: id, subjectId: claim.id })).toMatchObject([
      { artifactId: artifact.id, locator: 'page 4, paragraph 2', excerpt: evidence.excerpt }
    ]);
  });

  it('exports only an approved current manuscript with its exact claims and evidence snapshot', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidence.id] });
    const manuscript = repository.manuscripts.saveManuscript({ artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] });
    expect(() => repository.manuscripts.exportBundle({ projectId: id, artifactId: artifact.id })).toThrow('research_manuscript_approval_required');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' });
    expect(() => repository.evidence.updateClaim({ id: claim.id, expectedVersion: claim.version, content: 'Changed', status: 'pending', evidenceIds: [] }))
      .toThrow('research_stage_not_editable');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'approve' });
    repository = new ResearchRepository(db);
    const bundle = repository.manuscripts.exportBundle({ projectId: id, artifactId: artifact.id });
    expect(bundle.manuscript).toEqual(manuscript);
    expect(bundle.claims).toEqual([claim]);
    expect(bundle.evidence).toEqual([evidence]);
    expect(() => repository.evidence.updateClaim({ id: claim.id, expectedVersion: claim.version, content: 'Changed', status: 'supported', evidenceIds: [evidence.id] }))
      .toThrow('research_artifact_immutable');
  });

  it('requires saving again after a claim changes and refuses approval of a stale manuscript', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Initial result.', status: 'supported', evidenceIds: [evidence.id] });
    const request = { artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] };
    repository.manuscripts.saveManuscript(request);
    repository.evidence.updateClaim({ id: claim.id, expectedVersion: claim.version, content: 'Revised result.', status: 'supported', evidenceIds: [evidence.id] });
    expect(repository.evidence.claimHistory(claim.id)).toMatchObject([
      { version: 2, content: 'Revised result.' }, { version: 1, content: 'Initial result.' }
    ]);
    expect(() => repository.evidence.updateClaim({ id: claim.id, expectedVersion: 1, content: 'Stale overwrite.', status: 'supported', evidenceIds: [evidence.id] }))
      .toThrow('research_claim_version_conflict');
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' })).toThrow('research_manuscript_stale');
    expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'writing')?.status).toBe('running');
    repository.manuscripts.saveManuscript(request);
    expect(repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' }).currentStage).toBe('writing');
  });

  it('does not let an artifact borrow paragraphs from another artifact', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Result.', status: 'supported', evidenceIds: [evidence.id] });
    const other = repository.createArtifact({ projectId: id, stage: 'writing', kind: 'manuscript', title: 'Other draft', path: null });
    expect(() => repository.manuscripts.saveManuscript({ artifactId: other.id, sections: [{ title: 'Results', claimIds: [claim.id] }] }))
      .toThrow('research_claim_artifact_mismatch');
  });

  it('rejects writing completion without a traceable manuscript', () => {
    const { id } = manuscriptProject();
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' })).toThrow('research_manuscript_required');
  });

  it('refuses corrupted evidence during export even after approval', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph', content: 'Result.', status: 'supported', evidenceIds: [evidence.id] });
    repository.manuscripts.saveManuscript({ artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'approve' });
    db.prepare('UPDATE research_evidence SET excerpt = ? WHERE id = ?').run('Tampered source.', evidence.id);
    expect(() => repository.manuscripts.exportBundle({ projectId: id, artifactId: artifact.id })).toThrow('research_evidence_integrity_invalid');
  });
});
