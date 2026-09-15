import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { vectorToBlob } from '../../../../src/main/plugins/research/embedding-vectors';

let db: Database.Database;
let repository: ResearchRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  applyResearchDatabaseSchema(db, () => '2026-09-10T00:00:00.000Z');
  repository = new ResearchRepository(db, () => '2026-09-10T00:00:00.000Z');
});

afterEach(() => {
  db.close();
});

describe('ResearchRepository', () => {
  it('upgrades v4 templates without claiming an unverified legacy PDF is current', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.pragma('foreign_keys = ON');
      sqliteVec.load(legacy);
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((item) => item.version <= 4) });
      legacy.exec("INSERT INTO research_projects VALUES ('legacy-project','Legacy','Keep template','/tmp/legacy','active','discovery','2026-09-10T00:00:00.000Z','2026-09-10T00:00:00.000Z')");
      legacy.prepare(`INSERT INTO research_templates (id,project_id,root_path,entry_path,status,pdf_path,errors_json,last_compiled_at,updated_at)
        VALUES ('legacy-template','legacy-project','/tmp/legacy/template','main.tex','ready','/tmp/legacy/old.pdf','[]',NULL,'2026-09-10T00:00:00.000Z')`).run();
      applyResearchDatabaseSchema(legacy);
      applyResearchDatabaseSchema(legacy);
      const upgraded = new ResearchRepository(legacy).getTemplate({ projectId: 'legacy-project', templateId: 'legacy-template' });
      expect(upgraded).toMatchObject({ rootPath: '/tmp/legacy/template', entryPath: 'main.tex', pdfPath: '/tmp/legacy/old.pdf',
        status: 'imported', revision: 1, compiledRevision: null, sourceDigest: null, compiledDigest: null, pdfHash: null, activeCompileId: null, diagnostics: [] });
    } finally { legacy.close(); }
  });

  it('creates a project with an ordered, persisted eleven-stage workflow', () => {
    const project = repository.createProject({
      title: 'Evidence graph',
      description: 'Build a traceable evidence graph.',
      workspacePath: '/tmp/evidence-graph'
    });

    expect(project).toMatchObject({
      title: 'Evidence graph',
      status: 'active',
      language: 'zh',
      origin: null,
      currentStage: 'discovery'
    });
    const workflow = repository.getWorkflow(project.id);
    expect(workflow.stages).toHaveLength(11);
    expect(workflow.stages[0]).toMatchObject({ stage: 'discovery', status: 'ready', gateRequired: false });
    expect(workflow.stages[1]).toMatchObject({ stage: 'retrieval', status: 'locked', gateRequired: true });
  });

  it('advances discovery automatically and pauses at the first human gate', () => {
    const project = repository.createProject({
      title: 'Workflow test',
      description: 'Exercise stage transitions.',
      workspacePath: null
    });

    repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'discovery' });
    let workflow = repository.transitionWorkflow({ projectId: project.id, action: 'complete', expectedStage: 'discovery' });
    expect(workflow.currentStage).toBe('retrieval');
    expect(workflow.stages.find((stage) => stage.stage === 'retrieval')).toMatchObject({ status: 'ready' });

    repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'retrieval' });
    repository.createArtifact({
      projectId: project.id,
      stage: 'retrieval',
      kind: 'source_corpus',
      title: 'Retrieved evidence',
      path: null
    });
    workflow = repository.transitionWorkflow({ projectId: project.id, action: 'complete', expectedStage: 'retrieval' });
    expect(workflow.currentStage).toBe('retrieval');
    expect(workflow.stages.find((stage) => stage.stage === 'retrieval')).toMatchObject({
      status: 'waiting_approval',
      gateApproved: false
    });
  });

  it('requires approval before moving beyond a gated stage', () => {
    const project = repository.createProject({ title: 'Approval test', description: 'Approval.', workspacePath: null });
    repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'discovery' });
    repository.transitionWorkflow({ projectId: project.id, action: 'complete', expectedStage: 'discovery' });
    repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'retrieval' });
    const artifact = repository.createArtifact({
      projectId: project.id,
      stage: 'retrieval',
      kind: 'source_corpus',
      title: 'Approval evidence',
      path: null
    });
    repository.transitionWorkflow({ projectId: project.id, action: 'complete', expectedStage: 'retrieval' });

    const workflow = repository.transitionWorkflow({ projectId: project.id, action: 'approve', expectedStage: 'retrieval' });
    expect(workflow.currentStage).toBe('reading');
    expect(workflow.stages.find((stage) => stage.stage === 'retrieval')).toMatchObject({
      status: 'completed',
      gateApproved: true
    });
    expect(repository.getArtifact(artifact.id).status).toBe('approved');
  });

  it('rejects stale transitions so two views cannot advance different stages', () => {
    const project = repository.createProject({ title: 'Conflict test', description: 'Conflict.', workspacePath: null });

    expect(() =>
      repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'retrieval' })
    ).toThrow('research_workflow_stage_conflict:discovery');
  });

  it('combines FTS5 and sqlite-vec results with RRF ordering', () => {
    repository.knowledge.upsertKnowledgeDocument({
      id: 'doc-a',
      projectId: null,
      sourceType: 'literature',
      sourceId: 'paper-a',
      title: 'Evidence graph',
      content: 'evidence graph retrieval',
      chunks: [{ content: 'evidence graph retrieval', locator: 'p. 1' }],
      embeddingConfigId: null
    });
    repository.knowledge.upsertKnowledgeDocument({
      id: 'doc-b',
      projectId: null,
      sourceType: 'note',
      sourceId: 'note-b',
      title: 'Unrelated note',
      content: 'retrieval methods',
      chunks: [{ content: 'retrieval methods', locator: 'line 2' }],
      embeddingConfigId: null
    });
    repository.knowledge.saveEmbeddingConfig({ id: 'test', name: 'Test', baseUrl: 'https://embedding.test/v1', model: 'test-embedding', dimensions: 3, apiKey: 'sample-key', enabled: true }, 'sample-reference');
    repository.knowledge.storeChunkEmbeddings({
      configId: 'test', configRevision: 1,
      chunks: [...repository.knowledge.knowledgeChunks('doc-a'), ...repository.knowledge.knowledgeChunks('doc-b')],
      vectors: [vectorToBlob([1, 0, 0]), vectorToBlob([0, 1, 0])]
    });

    const result = repository.knowledge.searchKnowledge({
      request: { query: 'evidence', projectId: null, limit: 10, embeddingConfigId: 'test' },
      vector: { configId: 'test', configRevision: 1, blob: vectorToBlob([1, 0, 0]) }
    });

    expect(result.keywordCount).toBe(1);
    expect(result.vectorCount).toBe(2);
    expect(result.hits[0]).toMatchObject({ chunkId: 'doc-a:chunk:0', keywordRank: 1, vectorRank: 1 });
    expect(result.hits[0].rrfScore).toBeGreaterThan(result.hits[1].rrfScore);
  });

  it('creates and links artifacts to workflow stages', () => {
    const project = repository.createProject({
      title: 'Artifact test',
      description: 'Artifact domain.',
      workspacePath: null
    });

    const artifact = repository.createArtifact({
      projectId: project.id,
      stage: 'discovery',
      kind: 'search_strategy',
      title: 'Search strategy',
      path: '/tmp/search.md'
    });

    expect(repository.getArtifact(artifact.id)).toMatchObject({
      projectId: project.id,
      stage: 'discovery'
    });

    expect(repository.listArtifacts(project.id)).toHaveLength(1);

    const workflow = repository.getWorkflow(project.id);
    expect(workflow.stages[0].artifactIds).toContain(artifact.id);
  });

  it('requires an artifact before entering a gated approval flow', () => {
    const project = repository.createProject({
      title: 'Gate',
      description: 'Gate',
      workspacePath: null
    });

    repository.transitionWorkflow({
      projectId: project.id,
      action: 'start',
      expectedStage: 'discovery'
    });
    repository.transitionWorkflow({
      projectId: project.id,
      action: 'complete',
      expectedStage: 'discovery'
    });
    repository.transitionWorkflow({
      projectId: project.id,
      action: 'start',
      expectedStage: 'retrieval'
    });

    expect(() =>
      repository.transitionWorkflow({
        projectId: project.id,
        action: 'complete',
        expectedStage: 'retrieval'
      })
    ).toThrow('research_stage_artifact_required');
  });

  it('persists provenance and template compile state for audit and resume', () => {
    const project = repository.createProject({ title: 'Audit test', description: 'Audit.', workspacePath: '/tmp/audit' });
    const artifact = repository.createArtifact({ projectId: project.id, stage: 'discovery', kind: 'search_strategy', title: 'Strategy', path: null });
    const provenance = repository.addProvenance({
      projectId: project.id,
      artifactId: artifact.id,
      subjectType: 'artifact',
      subjectId: artifact.id,
      sourceType: 'literature',
      sourceId: 'doi:10.1000/test',
      locator: 'p. 4, para. 2',
      excerpt: 'Evidence excerpt'
    });
    expect(repository.listProvenance({ projectId: project.id, subjectId: artifact.id })).toEqual([provenance]);

    const template = repository.createTemplate({ id: 'template-1', projectId: project.id, rootPath: '/tmp/audit/template-1', entryPath: 'main.tex', sourceDigest: 'a'.repeat(64) });
    expect(template).toMatchObject({ status: 'imported', pdfPath: null });
    expect(repository.saveTemplate({ ...template, status: 'ready', pdfPath: '/tmp/audit/template-1/.roc-build/main.pdf', pdfHash: 'b'.repeat(64),
      compiledRevision: 1, compiledDigest: template.sourceDigest, errors: [], lastCompiledAt: '2026-09-10T00:00:00.000Z' }, 1))
      .toMatchObject({ status: 'ready', pdfPath: '/tmp/audit/template-1/.roc-build/main.pdf' });
  });
});
