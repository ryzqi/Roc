import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import type { ResearchExperimentEnvironment } from '../../../../src/shared/schemas/research-experiments';

describe('experiment persistence migration and provenance', () => {
  it('preserves v12 published executions and enforces a unique artifact association after upgrading', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      applyDatabaseMigrations(db, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 12) });
      const repository = new ResearchRepository(db);
      const project = repository.createProject({ title: 'Existing results', description: 'Keep published executions.', workspacePath: '/workspace' });
      const request = { projectId: project.id, requestId: 'published', label: 'Result', engine: 'python' as const, runtime: { kind: 'bundled-python' as const },
        sourcePath: 'run.py', inputPaths: [], arguments: [], parameters: {}, expectedEnvironmentHash: 'c'.repeat(64), timeoutMs: 10000, network: 'disabled' as const };
      const environment: ResearchExperimentEnvironment = { runtime: request.runtime, executable: '/python/bin/python', prefix: '/python', basePrefix: '/python',
        version: '3.12.14', platform: 'darwin', architecture: 'arm64', toolchainHash: 'a'.repeat(64), metadataHash: 'b'.repeat(64), packages: [], lockFiles: [], hash: request.expectedEnvironmentHash };
      const created = repository.experiments.create(request, '/workspace', '/workspace', '/managed-runs');
      repository.experiments.start(project.id, created.id, environment, [], 'd'.repeat(64));
      repository.experiments.finish(project.id, created.id, { status: 'completed', files: [], exitCode: 0, error: null });
      repository.transitionWorkflow({ projectId: project.id, expectedStage: 'discovery', action: 'move', targetStage: 'experiment' });
      const published = repository.experiments.publish(project.id, created.id);
      if (published.artifactId === null) throw new Error('test_artifact_required');
      const pending = repository.experiments.create({ ...request, requestId: 'pending' }, '/workspace', '/workspace', '/managed-runs');
      const artifact = repository.getArtifact(published.artifactId);
      applyResearchDatabaseSchema(db); applyResearchDatabaseSchema(db);
      expect(repository.experiments.forArtifact(artifact)).toEqual(published);
      expect(repository.experiments.get(project.id, pending.id)).toEqual(pending);
      expect(repository.getArtifact(artifact.id)).toEqual(artifact);
      expect(() => db.prepare("UPDATE research_experiment_executions SET snapshot_json = json_set(snapshot_json, '$.artifactId', ?) WHERE run_id = ?")
        .run(artifact.id, pending.id)).toThrow(/UNIQUE constraint/u);
      expect(repository.experiments.get(project.id, pending.id).artifactId).toBeNull();
    } finally { db.close(); }
  });

  it('preserves v9 experiment records without inventing executor snapshots and rejects cross-project rewrites', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      applyDatabaseMigrations(db, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 9) });
      const repository = new ResearchRepository(db);
      const project = repository.createProject({ title: 'Legacy', description: 'Legacy records.', workspacePath: null });
      const other = repository.createProject({ title: 'Other', description: 'Another project.', workspacePath: null });
      db.prepare("INSERT INTO research_experiment_runs VALUES (?,?,?,'python run.py','{}','{}','completed','[]',?,?)")
        .run('legacy', project.id, 'Legacy result', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:01.000Z');
      applyResearchDatabaseSchema(db); applyResearchDatabaseSchema(db);
      expect(repository.experiments.list(project.id, 10)).toEqual([]);
      expect(db.prepare('SELECT label,status FROM research_experiment_runs WHERE id = ?').get('legacy')).toEqual({ label: 'Legacy result', status: 'completed' });
      expect(() => repository.recordExperimentRun({ id: 'legacy', projectId: other.id, label: 'Overwrite', command: 'none', parameters: {}, environment: {}, status: 'failed', outputs: [], startedAt: '', endedAt: null }))
        .toThrow('research_experiment_project_mismatch');
      expect(() => repository.addProvenance({ projectId: other.id, artifactId: null, subjectType: 'experiment', subjectId: 'legacy', sourceType: 'file', sourceId: 'data.csv', locator: null, excerpt: null }))
        .toThrow('research_provenance_project_mismatch');
    } finally { db.close(); }
  });

  it('requires completed same-project experiments as provenance sources', () => {
    const db = new Database(':memory:');
    try {
      applyResearchDatabaseSchema(db);
      const repository = new ResearchRepository(db);
      const project = repository.createProject({ title: 'Project', description: 'Provenance.', workspacePath: null });
      const other = repository.createProject({ title: 'Other', description: 'Other provenance.', workspacePath: null });
      const request = { id: 'pending', projectId: project.id, label: 'Pending', command: 'python run.py', parameters: {}, environment: {}, status: 'running' as const, outputs: [], startedAt: '2026-09-12T00:00:00.000Z', endedAt: null };
      repository.recordExperimentRun(request);
      repository.recordExperimentRun({ ...request, id: 'elsewhere', projectId: other.id, status: 'completed' });
      const artifact = repository.createArtifact({ projectId: project.id, stage: 'discovery', kind: 'search_strategy', title: 'Study', path: null });
      const provenance = { projectId: project.id, artifactId: artifact.id, subjectType: 'artifact' as const, subjectId: artifact.id, sourceType: 'experiment' as const, sourceId: 'pending', locator: null, excerpt: null };
      expect(() => repository.addProvenance(provenance)).toThrow('research_provenance_source_invalid');
      expect(() => repository.addProvenance({ ...provenance, sourceId: 'elsewhere' })).toThrow('research_provenance_source_invalid');
      repository.recordExperimentRun({ ...request, status: 'completed', endedAt: '2026-09-12T00:00:01.000Z' });
      expect(repository.addProvenance(provenance).sourceId).toBe('pending');
    } finally { db.close(); }
  });
});
