import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { normalizeResearchDoi } from '../../../../src/main/plugins/research/literature-identity';
import { vectorToBlob } from '../../../../src/main/plugins/research/embedding-vectors';
import { libraryEntry } from './library-fixtures';

let db: Database.Database;
let repository: ResearchRepository;
let projectId: string;
const listRequest = { projectId: null, query: '', includeArchived: false, limit: 100 } as const;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Study', description: '', workspacePath: null }).id;
});
afterEach(() => db.close());

describe('research library repository', () => {
  it('normalizes DOI URLs and rejects malformed identities', () => {
    for (const value of [' 10.1234/ABC ', 'doi: 10.1234/ABC', 'https://doi.org/10.1234%2FABC', 'http://dx.doi.org/10.1234/ABC']) {
      expect(normalizeResearchDoi(value)).toBe('10.1234/abc');
    }
    for (const value of ['10.123/abc', '10.1234/with space', 'https://evil.org/10.1234/abc', 'https://user@doi.org/10.1234/abc',
      'https://doi.org/10.1234/abc?x=1', 'https://doi.org/10.1234/%zz', 'https://doi.org/10.1234/a\nb']) {
      expect(() => normalizeResearchDoi(value)).toThrow('research_doi_invalid');
    }
  });

  it('shares DOI duplicates across projects while preserving the first citation key and completing empty fields', () => {
    const original = libraryEntry({ authors: [], abstract: null, publishedYear: null }, { author: '', abstract: ' ', year: '' });
    const first = repository.library.import([original], projectId).items[0];
    const otherProject = repository.createProject({ title: 'Second study', description: '', workspacePath: null }).id;
    const incoming = libraryEntry({ id: 'openalex:second', source: 'openalex', externalId: 'second', doi: 'https://doi.org/10.1234/PAPER', abstract: 'Measured evidence' });
    incoming.bibliography.citationKey = 'new-key';
    const imported = repository.library.import([incoming], otherProject);
    expect(imported).toMatchObject({ createdCount: 0, duplicateCount: 1 });
    expect(imported.items[0]).toMatchObject({ id: first.id, revision: 2, metadata: { authors: ['Jane Doe'], abstract: 'Measured evidence', publishedYear: 2026 },
      bibliography: { citationKey: 'original', authors: ['Jane Doe'], abstract: 'Measured evidence', publishedYear: 2026,
        fields: { author: 'Jane Doe', abstract: 'Measured evidence', year: '2026' } } });
    expect(imported.items[0].sources).toHaveLength(2);
    expect(imported.items[0].projectIds.sort()).toEqual([projectId, otherProject].sort());
    expect(repository.library.list({ ...listRequest, projectId: otherProject }).map((item) => item.id)).toEqual([first.id]);
    repository.library.link(first.id, projectId, false);
    expect(repository.library.list({ ...listRequest, projectId })).toEqual([]);
    expect(repository.library.get(first.id).projectIds).toEqual([otherProject]);
  });

  it('uses source identity without merging unrelated works that only share a title', () => {
    const first = libraryEntry({ doi: null });
    const second = libraryEntry({ doi: null, source: 'openalex', externalId: 'other', id: 'openalex:other' });
    const result = repository.library.import([first, second, first], null);
    expect(result).toMatchObject({ createdCount: 2, duplicateCount: 1 });
    expect(result.items).toHaveLength(2);
    expect(repository.library.list(listRequest)).toHaveLength(2);
  });

  it('keeps publication date fields together when enriching a duplicate', () => {
    const original = libraryEntry({}, { date: '2026-09-11' });
    delete original.bibliography.fields.year;
    const item = repository.library.import([original], null).items[0];
    const incoming = libraryEntry({ publishedYear: 2009 }, { date: '2009-01', year: '2009', month: '1' });
    const merged = repository.library.import([incoming], null).items[0];
    expect(merged.id).toBe(item.id);
    expect(merged.metadata.publishedYear).toBe(2026);
    expect(merged.bibliography.fields.date).toBe('2026-09-11');
    expect(merged.bibliography.fields.year).toBeUndefined();
    expect(merged.bibliography.fields.month).toBeUndefined();

    const unknown = libraryEntry({ doi: '10.1234/unknown', publishedYear: null }, { date: 'in press' });
    repository.library.import([unknown], null);
    const completed = repository.library.import([libraryEntry({ doi: '10.1234/unknown' }, { date: '2026-09-11' })], null).items[0];
    expect(completed.bibliography).toMatchObject({ publishedYear: 2026, fields: { date: '2026-09-11', year: '2026' } });
  });

  it('preserves the first journal title across BibTeX and BibLaTeX field names', () => {
    repository.library.import([libraryEntry({}, { journaltitle: 'Primary Journal' })], null);
    const item = repository.library.import([libraryEntry({ source: 'doi' }, { journal: 'DOI Journal' })], null).items[0];
    expect(item.bibliography.fields.journaltitle).toBe('Primary Journal');
    expect(item.bibliography.fields.journal).toBeUndefined();
  });

  it('retains full source snapshots and adds nonconflicting CSL extensions on repeated DOI imports', () => {
    const original = libraryEntry();
    original.bibliography.csl = { id: 'first', type: 'article-journal', title: original.metadata.title, shared: 'original' };
    const incoming = libraryEntry({ source: 'doi', externalId: '10.1234/paper' }, { journal: 'Other Journal' });
    incoming.bibliography.csl = { id: 'second', type: 'article-journal', title: incoming.metadata.title, shared: 'incoming', added: 'preserved' };
    const first = repository.library.import([original], null).items[0];
    const result = repository.library.import([incoming], null).items[0];
    expect(result.id).toBe(first.id);
    expect(result.bibliography.csl).toMatchObject({ shared: 'original', added: 'preserved' });
    expect(result.sources).toEqual([original, incoming]);
    expect(repository.library.import([incoming], null).items[0].revision).toBe(result.revision);
  });

  it('rolls back records, project links and search documents when a batch fails during indexing', () => {
    db.exec("CREATE TRIGGER reject_second_document BEFORE INSERT ON research_knowledge_documents WHEN NEW.title = 'Rejected' BEGIN SELECT RAISE(ABORT, 'index_write_failed'); END;");
    expect(() => repository.library.import([libraryEntry(), libraryEntry({ doi: '10.1234/second', title: 'Rejected' })], projectId)).toThrow('index_write_failed');
    for (const table of ['research_library', 'research_library_projects', 'research_knowledge_documents', 'research_knowledge_chunks']) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it('rejects missing or archived projects before persisting any imported data', () => {
    expect(() => repository.library.import([libraryEntry()], 'missing')).toThrow('research_project_not_found');
    db.prepare("UPDATE research_projects SET status = 'archived' WHERE id = ?").run(projectId);
    expect(() => repository.library.import([libraryEntry()], projectId)).toThrow('research_project_archived');
    expect(repository.library.list(listRequest)).toEqual([]);
  });

  it('keeps embeddings and revisions on an unchanged reimport and treats search wildcards literally', () => {
    const entry = libraryEntry({ title: 'A 50% improvement' });
    const first = repository.library.import([entry], null).items[0];
    repository.saveEmbeddingConfig({ id: 'test', name: 'Test', baseUrl: 'https://embedding.test/v1', model: 'test', dimensions: 3, apiKey: 'sample-key', enabled: true }, 'sample-reference');
    repository.storeChunkEmbeddings({ configId: 'test', configRevision: 1, chunks: repository.knowledgeChunks(`library:${first.id}`), vectors: [vectorToBlob([1, 0, 0])] });
    const repeat = { ...entry, metadata: { ...entry.metadata, importedAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' } };
    expect(repository.library.import([repeat], null).items[0].revision).toBe(first.revision);
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_embeddings').get()).toEqual({ count: 1 });
    expect(repository.library.list({ ...listRequest, query: '%' }).map((item) => item.id)).toEqual([first.id]);
    expect(repository.library.list({ ...listRequest, query: '_' })).toEqual([]);
    db.prepare("UPDATE research_knowledge_documents SET source_type = 'note' WHERE id = ?").run(`library:${first.id}`);
    repository.library.import([entry], null);
    expect(db.prepare('SELECT source_type FROM research_knowledge_documents WHERE id = ?').get(`library:${first.id}`)).toEqual({ source_type: 'literature' });
  });

  it('archives and restores search material without deleting captured evidence', () => {
    const item = repository.library.import([libraryEntry({ abstract: 'Measured result' })], projectId).items[0];
    const evidence = repository.evidence.capture({ projectId, chunkId: `library:${item.id}:chunk:1` });
    const archived = repository.library.archive(item.id, item.revision, true);
    expect(repository.library.list(listRequest)).toEqual([]);
    expect(repository.library.list({ ...listRequest, includeArchived: true })).toEqual([archived]);
    expect(repository.evidence.list(projectId)).toEqual([evidence]);
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents').get()).toEqual({ count: 0 });
    expect(() => repository.library.link(item.id, projectId, true)).toThrow('research_library_item_archived');
    expect(repository.library.link(item.id, projectId, false).projectIds).toEqual([]);
    expect(() => repository.library.archive(item.id, item.revision, false)).toThrow('research_library_version_conflict');
    const restored = repository.library.archive(item.id, archived.revision, false);
    expect(repository.library.list(listRequest)).toEqual([restored]);
    expect(repository.evidence.capture({ projectId, chunkId: `library:${item.id}:chunk:1` })).toEqual(evidence);
  });

  it('rejects stale citation edits and malformed keys', () => {
    const item = repository.library.import([libraryEntry()], null).items[0];
    const edited = repository.library.setCitationKey(item.id, item.revision, 'doe2026');
    expect(edited.bibliography.citationKey).toBe('doe2026');
    expect(() => repository.library.setCitationKey(item.id, item.revision, 'stale')).toThrow('research_library_version_conflict');
    expect(() => repository.library.setCitationKey(item.id, edited.revision, 'invalid key')).toThrow();
    expect(repository.library.get(item.id)).toEqual(edited);
  });

  it('does not reassign existing knowledge material between project and global scopes', () => {
    const request = { id: 'project-document', projectId, sourceType: 'file' as const, sourceId: 'data.csv', title: 'Data', content: '42',
      chunks: [{ content: '42', locator: 'row 1' }], embeddingConfigId: null };
    repository.upsertKnowledgeDocument(request);
    expect(() => repository.upsertKnowledgeDocument({ ...request, projectId: null, content: 'reassigned' })).toThrow('research_knowledge_project_mismatch');
    expect(db.prepare('SELECT project_id,content FROM research_knowledge_documents WHERE id = ?').get(request.id)).toEqual({ project_id: projectId, content: '42' });
  });

  it('upgrades v5 in place without modifying project or knowledge records', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.pragma('foreign_keys = ON');
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((item) => item.version <= 5) });
      legacy.exec("INSERT INTO research_projects VALUES ('legacy','Legacy','Keep','/tmp/legacy','active','discovery','2026-09-10T00:00:00.000Z','2026-09-10T00:00:00.000Z')");
      applyResearchDatabaseSchema(legacy);
      applyResearchDatabaseSchema(legacy);
      const upgraded = new ResearchRepository(legacy);
      expect(upgraded.getProject('legacy')).toMatchObject({ title: 'Legacy', workspacePath: '/tmp/legacy' });
      const imported = upgraded.library.import([libraryEntry()], 'legacy');
      expect(imported.items[0].projectIds).toEqual(['legacy']);
    } finally { legacy.close(); }
  });
});
