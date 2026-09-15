import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { knowledgeId, type IndexPayload } from '../../../../src/main/plugins/research/index-repository';
import { defaultResearchIndexOptions } from '../../../../src/shared/schemas/research-index';

let db: Database.Database;
let repository: ResearchRepository;
let projectId: string;
const file = { path: 'study.md', kind: 'markdown' as const, size: 6, signature: 'signature-1' };
const payload = (content = 'Source'): IndexPayload => ({ content, chunks: [{ content, locator: 'lines 1-1' }], sourceHash: 'a'.repeat(64), parserKey: 'roc-text-1', parserVersion: 'roc-text-1' });
function job(force = false) {
  const scan = repository.indexing.beginScan(projectId);
  repository.indexing.reconcile(projectId, scan, [file], force, null, new Map([['markdown', 'roc-text-1']]));
  const queued = repository.indexing.nextJob();
  if (queued === null) throw new Error('expected_index_job');
  return repository.indexing.beginJob(queued.id);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Project', description: 'Index transactions.', workspacePath: '/project' }).id;
  repository.indexing.bindRoot(projectId, '/project');
});
afterEach(() => db.close());

describe('persistent research index boundaries', () => {
  it('rejects a stale task after settings change without publishing its text', () => {
    const active = job();
    const settings = repository.indexing.settings(projectId);
    repository.indexing.saveSettings(projectId, settings.revision, { ...defaultResearchIndexOptions, paused: true });
    expect(() => repository.indexing.publishText(active, payload(), 'sources/source.md')).toThrow('research_index_scope_changed');
    expect(repository.indexing.job(active.id).status).toBe('cancelled');
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents').get()).toEqual({ count: 0 });
  });

  it('rolls back text, source history and file metadata together when indexing fails', () => {
    const active = job();
    db.exec("CREATE TRIGGER reject_index BEFORE INSERT ON research_knowledge_documents BEGIN SELECT RAISE(ABORT, 'index_write_failed'); END;");
    expect(() => repository.indexing.publishText(active, payload(), 'sources/source.md')).toThrow('index_write_failed');
    expect(db.prepare('SELECT count(*) AS count FROM research_index_sources').get()).toEqual({ count: 0 });
    expect(repository.indexing.listFiles(projectId, '', false, 10)[0]).toMatchObject({ indexedHash: null, textIndexed: false });
  });

  it('publishes a new extraction on forced rebuild even when source and parser identity are unchanged', () => {
    const first = job();
    repository.indexing.publishText(first, payload(), 'sources/source.md');
    repository.indexing.finishJob(first, null);
    const second = job(true);
    repository.indexing.publishText(second, payload('New extraction'), 'sources/source.md');
    repository.indexing.finishJob(second, null);
    expect(repository.knowledge.knowledgeDocument(knowledgeId(second.fileId)).content).toBe('New extraction');
    expect(repository.indexing.cached(second.fileId).payload?.content).toBe('New extraction');
  });

  it('does not mark a task ready under another embedding configuration', () => {
    const active = job();
    repository.indexing.publishText(active, payload(), 'sources/source.md');
    expect(() => repository.indexing.finishJob(active, { configId: 'another', revision: 1 })).toThrow('research_index_embedding_changed');
    expect(repository.indexing.job(active.id).status).toBe('running');
  });

  it.each(['queued', 'running', 'failed'] as const)('requeues %s work when the parser changes without retrying unchanged failures', (status) => {
    const active = job();
    repository.indexing.publishText(active, payload(), 'sources/source.md');
    repository.indexing.finishJob(active, null);
    const rebuild = job(true);
    if (status === 'queued') {
      repository.indexing.recover();
      repository.indexing.reconcile(projectId, repository.indexing.beginScan(projectId), [file], false, null, new Map([['markdown', 'roc-text-1']]));
    } else if (status === 'failed') repository.indexing.failJob(rebuild, 'parser_failed', false);
    const previous = repository.indexing.listJobs(projectId, 10)[0];
    repository.indexing.reconcile(projectId, repository.indexing.beginScan(projectId), [file], false, null, new Map([['markdown', 'roc-text-1']]));
    expect(repository.indexing.listJobs(projectId, 10)[0].id).toBe(previous.id);
    repository.indexing.reconcile(projectId, repository.indexing.beginScan(projectId), [file], false, null, new Map([['markdown', 'roc-text-2']]));
    const next = repository.indexing.nextJob();
    expect(next).toMatchObject({ fileId: active.fileId, input: { parserKey: 'roc-text-2', force: true } });
    expect(next?.id).not.toBe(previous.id);
    expect(repository.indexing.job(previous.id).status).toBe(status === 'failed' ? 'failed' : 'cancelled');
    if (next === null) throw new Error('expected_index_job');
    repository.indexing.failJob(repository.indexing.beginJob(next.id), 'parser_failed', false);
    repository.indexing.reconcile(projectId, repository.indexing.beginScan(projectId), [file], false, null, new Map([['markdown', 'roc-text-2']]));
    expect(repository.indexing.nextJob()).toBeNull();
    expect(repository.indexing.listFiles(projectId, '', false, 10)[0].status).toBe('failed');
  });

  it('snapshots source metadata into evidence and rolls back evidence when snapshot persistence fails', () => {
    const request = { id: 'metadata-source', projectId, sourceType: 'file' as const, sourceId: 'source.md', title: 'Source', content: 'Evidence',
      chunks: [{ content: 'Evidence', locator: 'line 1' }], embeddingConfigId: null };
    repository.knowledge.upsertKnowledgeDocument(request, { version: 'first' });
    db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON research_evidence_source_metadata BEGIN SELECT RAISE(ABORT, 'snapshot_failed'); END;");
    expect(() => repository.evidence.capture({ projectId, chunkId: 'metadata-source:chunk:0' })).toThrow('snapshot_failed');
    expect(repository.evidence.list(projectId)).toEqual([]);
    db.exec('DROP TRIGGER fail_snapshot');
    const first = repository.evidence.capture({ projectId, chunkId: 'metadata-source:chunk:0' });
    repository.knowledge.upsertKnowledgeDocument(request, { version: 'second' });
    const second = repository.evidence.capture({ projectId, chunkId: 'metadata-source:chunk:0' });
    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    expect(repository.evidence.sourceMetadata(projectId, first.id)).toEqual({ version: 'first' });
    expect(repository.evidence.sourceMetadata(projectId, second.id)).toEqual({ version: 'second' });
  });

  it('migrates v8 project settings while preserving legacy evidence identity', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.pragma('foreign_keys = ON');
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 8) });
      legacy.exec("INSERT INTO research_projects VALUES ('legacy','Legacy','Old project','/project','active','discovery','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z')");
      const old = new ResearchRepository(legacy);
      old.knowledge.upsertKnowledgeDocument({ id: 'old-source', projectId: 'legacy', sourceType: 'file', sourceId: 'source.md', title: 'Source', content: 'Evidence',
        chunks: [{ content: 'Evidence', locator: 'line 1' }], embeddingConfigId: null });
      const evidence = old.evidence.capture({ projectId: 'legacy', chunkId: 'old-source:chunk:0' });
      applyResearchDatabaseSchema(legacy);
      applyResearchDatabaseSchema(legacy);
      expect(old.indexing.settings('legacy')).toEqual({ ...defaultResearchIndexOptions, projectId: 'legacy', revision: 1 });
      expect(old.evidence.capture({ projectId: 'legacy', chunkId: 'old-source:chunk:0' })).toEqual(evidence);
      expect(old.evidence.sourceMetadata('legacy', evidence.id)).toBeNull();
    } finally { legacy.close(); }
  });
});
