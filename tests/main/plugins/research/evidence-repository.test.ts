import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
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
  repository.upsertKnowledgeDocument({
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

describe('research evidence and manuscript boundaries', () => {
  it('captures an immutable, deduplicated excerpt that survives source reindexing and deletion', () => {
    const { id } = project();
    document(null);
    const evidence = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    expect(evidence.excerpt).toBe('  Measured improvement: 20%.  ');
    expect(repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' })).toEqual(evidence);
    document(null, { content: 'New version', chunks: [{ content: 'New version', locator: 'page 5' }] });
    const updated = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    expect(updated.id).not.toBe(evidence.id);
    db.prepare('DELETE FROM research_knowledge_documents WHERE id = ?').run('paper');
    expect(repository.evidence.list(id)).toEqual([updated, evidence]);
  });

  it('rejects private sources from another project, missing locators and uncited notes', () => {
    const first = project();
    const second = project();
    document(first.id);
    expect(() => repository.evidence.capture({ projectId: second.id, chunkId: 'paper:chunk:0' })).toThrow('research_evidence_project_mismatch');
    document(first.id, { chunks: [{ content: 'No locator', locator: null }] });
    expect(() => repository.evidence.capture({ projectId: first.id, chunkId: 'paper:chunk:0' })).toThrow('research_evidence_locator_required');
    document(first.id, { sourceType: 'note' });
    expect(() => repository.evidence.capture({ projectId: first.id, chunkId: 'paper:chunk:0' })).toThrow('research_evidence_source_unsupported');
  });

  it('distinguishes source metadata changes even when the excerpt is unchanged', () => {
    const { id } = project();
    document(id);
    const original = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    document(id, { sourceId: 'corrected-paper.pdf', title: 'Corrected source' });
    const corrected = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    expect(corrected.id).not.toBe(original.id);
    expect(repository.evidence.list(id).map((entry) => entry.sourceId)).toEqual(['corrected-paper.pdf', 'paper.pdf']);
  });

  it('requires evidence for supported claims and verifies project ownership', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const input = { projectId: id, artifactId: artifact.id, subjectType: 'paragraph' as const,
      content: 'The measured improvement was 20%.', status: 'supported' as const, evidenceIds: [] };
    expect(() => repository.evidence.createClaim(input)).toThrow('research_claim_evidence_required');
    const foreign = project();
    const otherArtifact = repository.createArtifact({ projectId: foreign.id, stage: 'discovery', kind: 'search_strategy', title: 'Other', path: null });
    expect(() => repository.evidence.createClaim({ ...input, projectId: foreign.id, artifactId: otherArtifact.id, evidenceIds: [evidence.id] }))
      .toThrow('research_evidence_project_mismatch');
    expect(repository.evidence.listClaims({ projectId: id })).toEqual([]);
  });

  it('validates claim subjects at the generic provenance boundary as well', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Result.', status: 'supported', evidenceIds: [evidence.id] });
    const other = project();
    expect(() => repository.addProvenance({ projectId: other.id, artifactId: null, subjectType: 'paragraph', subjectId: claim.id,
      sourceType: 'model_run', sourceId: 'run-1', locator: null, excerpt: null })).toThrow('research_provenance_project_mismatch');
    expect(() => repository.addProvenance({ projectId: id, artifactId: null, subjectType: 'paragraph', subjectId: claim.id,
      sourceType: 'model_run', sourceId: 'run-1', locator: null, excerpt: null })).toThrow('research_provenance_subject_mismatch');
  });

  it('keeps a hypothesis as a draft and blocks its inclusion in manuscript prose', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Improvement may reach 20%.', status: 'hypothesis', evidenceIds: [] });
    const request = { artifactId: artifact.id, sections: [{ title: 'Results & analysis', claimIds: [claim.id] }] };
    expect(() => repository.evidence.saveManuscript(request)).toThrow('research_claim_unverified');
    expect(repository.evidence.getManuscript(artifact.id)).toBeNull();
    repository.evidence.updateClaim({ id: claim.id, expectedVersion: claim.version, content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidence.id] });
    const manuscript = repository.evidence.saveManuscript(request);
    expect(manuscript.latex).toContain('Results \\& analysis');
    expect(manuscript.latex).toContain('Measured improvement: 20\\%.');
    expect(manuscript.latex).toContain(`\\cite{${evidence.id}}`);
    expect(manuscript.latex).toContain('page 4, paragraph 2');
    expect(repository.listProvenance({ projectId: id, subjectId: claim.id })).toMatchObject([
      { artifactId: artifact.id, locator: 'page 4, paragraph 2', excerpt: evidence.excerpt }
    ]);
  });

  it('preserves audit edges and prior evidence when a claim is revised', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Initial result.', status: 'supported', evidenceIds: [evidence.id] });
    const event = repository.listWorkflowEvents({ projectId: id, limit: 1 })[0];
    const audit = repository.addProvenance({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph', subjectId: claim.id,
      sourceType: 'workflow_event', sourceId: event.id, locator: null, excerpt: 'Human audit.' });
    repository.evidence.updateClaim({ id: claim.id, expectedVersion: 1, content: 'Revised result.', status: 'supported', evidenceIds: [evidence.id] });
    const edges = repository.listProvenance({ projectId: id, subjectId: claim.id });
    expect(edges).toContainEqual(audit);
    expect(edges.filter((edge) => edge.sourceType === 'file')).toHaveLength(1);
    repository.evidence.updateClaim({ id: claim.id, expectedVersion: 2, content: 'Needs validation.', status: 'pending', evidenceIds: [] });
    expect(repository.listProvenance({ projectId: id, subjectId: claim.id })).toEqual(edges);
    expect(repository.evidence.claimHistory(claim.id).map((version) => version.evidenceIds)).toEqual([[], [evidence.id], [evidence.id]]);
  });

  it('distinguishes figure entities from figure claims in provenance', () => {
    const { id } = project();
    const figure = repository.recordFigure({ id: 'figure-1', projectId: id, title: 'Figure', codePath: 'plot.py',
      dataPaths: ['data.csv'], outputPaths: [], status: 'draft', runId: null });
    const edge = repository.addProvenance({ projectId: id, artifactId: null, subjectType: 'figure', subjectId: figure.id,
      sourceType: 'file', sourceId: 'data.csv', locator: 'rows 2-3', excerpt: 'Measured data.' });
    expect(repository.listProvenance({ projectId: id, subjectId: figure.id })).toEqual([edge]);
  });

  it('exports only an approved current manuscript with its exact claims and evidence snapshot', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidence.id] });
    const manuscript = repository.evidence.saveManuscript({ artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] });
    expect(() => repository.evidence.exportBundle({ projectId: id, artifactId: artifact.id })).toThrow('research_manuscript_approval_required');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' });
    expect(() => repository.evidence.updateClaim({ id: claim.id, expectedVersion: claim.version, content: 'Changed', status: 'pending', evidenceIds: [] }))
      .toThrow('research_stage_not_editable');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'approve' });
    repository = new ResearchRepository(db);
    const bundle = repository.evidence.exportBundle({ projectId: id, artifactId: artifact.id });
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
    repository.evidence.saveManuscript(request);
    repository.evidence.updateClaim({ id: claim.id, expectedVersion: claim.version, content: 'Revised result.', status: 'supported', evidenceIds: [evidence.id] });
    expect(repository.evidence.claimHistory(claim.id)).toMatchObject([
      { version: 2, content: 'Revised result.' }, { version: 1, content: 'Initial result.' }
    ]);
    expect(() => repository.evidence.updateClaim({ id: claim.id, expectedVersion: 1, content: 'Stale overwrite.', status: 'supported', evidenceIds: [evidence.id] }))
      .toThrow('research_claim_version_conflict');
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' })).toThrow('research_manuscript_stale');
    expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'writing')?.status).toBe('running');
    repository.evidence.saveManuscript(request);
    expect(repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' }).currentStage).toBe('writing');
  });

  it('does not let an artifact borrow paragraphs from another artifact', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Result.', status: 'supported', evidenceIds: [evidence.id] });
    const other = repository.createArtifact({ projectId: id, stage: 'writing', kind: 'manuscript', title: 'Other draft', path: null });
    expect(() => repository.evidence.saveManuscript({ artifactId: other.id, sections: [{ title: 'Results', claimIds: [claim.id] }] }))
      .toThrow('research_claim_artifact_mismatch');
  });

  it('rejects writing completion without a traceable manuscript', () => {
    const { id } = manuscriptProject();
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' })).toThrow('research_manuscript_required');
  });

  it('requires figure evidence and a real render before it can be submitted for approval', () => {
    const { id } = project();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'figure' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'figure', action: 'start' });
    const artifact = repository.createArtifact({ projectId: id, stage: 'figure', kind: 'figure', title: 'Comparison', path: null });
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'figure', action: 'complete' })).toThrow('research_figure_evidence_required');
    document(id);
    const evidence = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'figure', content: 'Measured comparison.', status: 'supported', evidenceIds: [evidence.id] });
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'figure', action: 'complete' })).toThrow('research_figure_render_required');
  });

  it('refuses corrupted evidence during export even after approval', () => {
    const { id, artifact, evidence } = manuscriptProject();
    const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph', content: 'Result.', status: 'supported', evidenceIds: [evidence.id] });
    repository.evidence.saveManuscript({ artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'approve' });
    db.prepare('UPDATE research_evidence SET excerpt = ? WHERE id = ?').run('Tampered source.', evidence.id);
    expect(() => repository.evidence.exportBundle({ projectId: id, artifactId: artifact.id })).toThrow('research_evidence_integrity_invalid');
  });

  it('rolls back a claim when writing its provenance fails', () => {
    const { id, artifact, evidence } = manuscriptProject();
    db.exec("CREATE TRIGGER fail_provenance BEFORE INSERT ON research_provenance BEGIN SELECT RAISE(ABORT, 'provenance_failed'); END");
    expect(() => repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Result.', status: 'supported', evidenceIds: [evidence.id] })).toThrow('provenance_failed');
    expect(repository.evidence.listClaims({ projectId: id })).toEqual([]);
  });

  it('upgrades the previous schema without changing stored projects or its migration checksum', () => {
    const legacy = new Database(':memory:');
    try {
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.slice(0, 1) });
      const old = { id: 'legacy-project', title: 'Existing', description: 'Preserve me.', workspacePath: null,
        status: 'active', currentStage: 'discovery', createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z' };
      legacy.prepare('INSERT INTO research_projects (id, title, description, workspace_path, status, current_stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(old.id, old.title, old.description, old.workspacePath, old.status, old.currentStage, old.createdAt, old.updatedAt);
      legacy.prepare("INSERT INTO research_stage_states (project_id, stage, status, active_run_id, artifact_ids_json, entered_at, completed_at, gate_required, gate_approved, last_error) VALUES (?, 'discovery', 'ready', NULL, '[]', ?, NULL, 0, 0, NULL)")
        .run(old.id, old.createdAt);
      applyResearchDatabaseSchema(legacy);
      applyResearchDatabaseSchema(legacy);
      const upgraded = new ResearchRepository(legacy);
      expect(upgraded.getProject(old.id)).toEqual(old);
      expect(upgraded.evidence.list(old.id)).toEqual([]);
      expect(upgraded.runs.listPolicies(old.id)).toMatchObject([{ stage: 'discovery', model: { kind: 'app_default' } }]);
    } finally {
      legacy.close();
    }
  });
});
