import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { ResearchDocumentService } from '../../../../src/main/plugins/research/document-service';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import { ResearchProcessError } from '../../../../src/main/plugins/research/process-runner';
import type { ResearchToolchain } from '../../../../src/main/plugins/research/toolchain';
import type { ResearchLiterature } from '../../../../src/shared/types';
import { libraryEntry } from './library-fixtures';

type Parse = ResearchToolchain['parseDocument'];
const parse = vi.fn<Parse>();
const normalize = vi.fn<ResearchToolchain['normalizeBibliography']>();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
let db: Database.Database;
let repository: ResearchRepository;
let service: ResearchDocumentService;
let root: string;
let source: string;
let projectId: string;

async function parsedOutput(input: Parameters<Parse>[0], text = 'Measured value: 42.'): ReturnType<Parse> {
  await mkdir(input.outputDir, { recursive: true });
  await writeFile(join(input.outputDir, 'page-1.png'), png);
  await writeFile(join(input.outputDir, 'table-0.png'), png);
  return { sourceHash: researchContentHash(await readFile(input.sourcePath)), parserVersion: 'test-parser', pageCount: 1, content: text, warnings: [],
    blocks: [{ id: '#/tables/0', kind: 'table', label: 'table', text, locator: 'pages 1; #/tables/0', imagePath: 'table-0.png',
      locations: [{ page: 1, bbox: [0, 0, 100, 200], coordinateOrigin: 'TOPLEFT' }] }],
    assets: [{ path: 'page-1.png', kind: 'page', page: 1 }, { path: 'table-0.png', kind: 'table', page: 1 }] };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function importDocument(): ReturnType<ResearchDocumentService['import']> {
  return await service.import({ target: 'new-item', sourcePath: source, title: 'Measured study', citationKey: 'study2026', projectId });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-documents-')));
  source = join(root, 'original.pdf');
  await writeFile(source, '%PDF-1.7\nimmutable source');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Study', description: 'Document tests.', workspacePath: root }).id;
  parse.mockReset().mockImplementation((input) => parsedOutput(input));
  normalize.mockReset().mockImplementation(async (input) => {
    const [{ metadata, citationKey }] = JSON.parse(await readFile(input.sourcePath, 'utf8')) as Array<{ metadata: ResearchLiterature; citationKey: string }>;
    return [{ ...libraryEntry(metadata).bibliography, citationKey, entryType: 'misc' }];
  });
  service = new ResearchDocumentService(repository, { parseDocument: parse, normalizeBibliography: normalize }, join(root, 'library'));
});
afterEach(async () => { await service.shutdown(); db.close(); await rm(root, { recursive: true, force: true }); });

describe('research document lifecycle', () => {
  it('imports an immutable source and reuses identical attachments without changing the original', async () => {
    const original = await readFile(source);
    const document = await importDocument();
    expect(document).toMatchObject({ filename: 'original.pdf', mediaType: 'application/pdf', sourceHash: researchContentHash(original), status: 'imported', currentParseId: null });
    expect(repository.library.get(document.libraryItemId).projectIds).toEqual([projectId]);
    const duplicate = await service.import({ target: 'library-item', libraryItemId: document.libraryItemId, sourcePath: source, projectId: null });
    expect(duplicate).toEqual(document);
    expect(await readdir(join(root, 'library/documents'))).toEqual([document.id]);
    await writeFile(source, 'external edit');
    expect((await service.source({ documentId: document.id, sourceHash: document.sourceHash })).bytes).toEqual(original);
  });

  it('rolls back a new library record, links and files when attachment persistence fails', async () => {
    db.exec("CREATE TRIGGER fail_document BEFORE INSERT ON research_documents BEGIN SELECT RAISE(ABORT, 'document_insert_failed'); END;");
    await expect(importDocument()).rejects.toThrow('document_insert_failed');
    expect(db.prepare('SELECT count(*) AS count FROM research_library').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM research_library_projects').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents').get()).toEqual({ count: 0 });
    expect(await readdir(join(root, 'library/documents'))).toEqual([]);
    expect(await readFile(source, 'utf8')).toContain('immutable source');
  });

  it('rejects invalid destinations and symlinks before parsing or creating records', async () => {
    await expect(service.import({ target: 'new-item', sourcePath: source, title: 'Study', citationKey: 'study', projectId: 'missing' })).rejects.toThrow('research_project_not_found');
    const link = join(root, 'symlink.pdf');
    await symlink(source, link);
    await expect(service.import({ target: 'new-item', sourcePath: link, title: 'Study', citationKey: 'study', projectId })).rejects.toThrow('research_document_source_invalid');
    expect(normalize).not.toHaveBeenCalled();
    expect(repository.library.list({ projectId: null, query: '', includeArchived: true, limit: 100 })).toEqual([]);
  });

  it('publishes located full text and immutable resource versions while preserving old evidence', async () => {
    const document = await importDocument();
    const first = await service.parse(document.id);
    expect(first).toMatchObject({ status: 'ready', activeParseId: null, error: null });
    if (first.currentParseId === null) throw new Error('parse_id_required');
    const content = service.parsed(document.id, first.currentParseId);
    expect(content.content.blocks[0]).toMatchObject({ locator: 'pages 1; #/tables/0', imageAssetId: 'asset_1' });
    expect(await service.asset({ documentId: document.id, parseId: first.currentParseId, assetId: 'asset_1', sha256: content.content.assets[1].sha256 })).toEqual(png);
    const evidence = repository.evidence.capture({ projectId, chunkId: `document:${first.currentParseId}:chunk:0` });
    expect(evidence.excerpt).toBe('Measured value: 42.');
    parse.mockImplementationOnce((input) => parsedOutput(input, 'Corrected reading: 45.'));
    const second = await service.parse(document.id);
    expect(second.currentParseId).not.toBe(first.currentParseId);
    expect(repository.documents.runs(document.id)).toHaveLength(2);
    expect(service.parsed(document.id, first.currentParseId)).toEqual(content);
    expect(repository.evidence.list(projectId)).toEqual([evidence]);
    expect(db.prepare('SELECT id FROM research_knowledge_documents WHERE id = ?').get(`document:${first.currentParseId}`)).toBeUndefined();
    expect(repository.searchKnowledge({ request: { query: 'Corrected', projectId, limit: 10, embeddingConfigId: null }, vector: null }).hits[0].content).toContain('45');
  });

  it('preserves the last successful parse and index when a retry or index transaction fails', async () => {
    const document = await importDocument();
    const ready = await service.parse(document.id);
    parse.mockRejectedValueOnce(new ResearchProcessError('research_process_timeout'));
    const failed = await service.parse(document.id);
    expect(failed).toMatchObject({ status: 'failed', currentParseId: ready.currentParseId, activeParseId: null, error: 'research_process_timeout' });
    db.exec("CREATE TRIGGER fail_document_index BEFORE INSERT ON research_knowledge_documents WHEN NEW.id LIKE 'document:%' BEGIN SELECT RAISE(ABORT, 'index_failed'); END;");
    const rejected = await service.parse(document.id);
    expect(rejected).toMatchObject({ status: 'failed', currentParseId: ready.currentParseId, activeParseId: null });
    expect(repository.documents.runs(document.id).map((run) => run.status)).toEqual(['failed', 'failed', 'ready']);
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents WHERE id LIKE ?').get('document:%')).toEqual({ count: 1 });
    expect(await readdir(join(root, `library/documents/${document.id}/runs`))).toEqual([ready.currentParseId]);
  });

  it('discards a cancelled late result, allows a new parse and waits for both tasks on shutdown', async () => {
    const document = await importDocument();
    const entered = deferred();
    const release = deferred();
    parse.mockImplementationOnce(async (input) => { entered.resolve(); await release.promise; return await parsedOutput(input, 'Late result'); });
    const pending = service.parse(document.id);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      const parseId = repository.documents.get(document.id).activeParseId;
      if (parseId === null) throw new Error('parse_id_required');
      expect(service.cancel(document.id, parseId)).toMatchObject({ status: 'cancelled', activeParseId: null });
      const retry = await service.parse(document.id);
      let closed = false;
      closing = service.shutdown().then(() => { closed = true; });
      await Promise.resolve();
      const completedBeforeRelease = closed;
      release.resolve();
      await pending;
      await closing;
      expect(completedBeforeRelease).toBe(false);
      expect(repository.documents.get(document.id)).toEqual(retry);
      expect(repository.documents.runs(document.id).map((run) => run.status)).toEqual(['ready', 'cancelled']);
      expect(await readdir(join(root, `library/documents/${document.id}/runs`))).toEqual([retry.currentParseId]);
    } finally { release.resolve(); await pending; await closing; }
  });

  it('does not create a document or library record when shutdown races with normalization', async () => {
    const entered = deferred();
    const release = deferred();
    normalize.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return [libraryEntry({ title: 'Measured study', authors: [], doi: null, publishedYear: null }).bibliography]; });
    const pending = importDocument();
    await entered.promise;
    const closing = service.shutdown();
    release.resolve();
    await expect(pending).rejects.toThrow('research_document_parse_cancelled');
    await closing;
    expect(db.prepare('SELECT count(*) AS count FROM research_documents').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM research_library').get()).toEqual({ count: 0 });
    expect(await readdir(join(root, 'library/documents'))).toEqual([]);
  });

  it('removes and restores full text search on archive while keeping captured evidence and original resources', async () => {
    const document = await importDocument();
    const ready = await service.parse(document.id);
    if (ready.currentParseId === null) throw new Error('parse_id_required');
    const evidence = repository.evidence.capture({ projectId, chunkId: `document:${ready.currentParseId}:chunk:0` });
    const item = repository.library.get(document.libraryItemId);
    const archived = repository.library.archive(item.id, item.revision, true);
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents').get()).toEqual({ count: 0 });
    expect(repository.evidence.list(projectId)).toEqual([evidence]);
    expect((await service.source({ documentId: document.id, sourceHash: document.sourceHash })).bytes.toString()).toContain('immutable source');
    await expect(service.parse(document.id)).rejects.toThrow('research_library_item_archived');
    repository.library.archive(item.id, archived.revision, false);
    expect(repository.evidence.capture({ projectId, chunkId: `document:${ready.currentParseId}:chunk:0` })).toEqual(evidence);
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents WHERE id LIKE ?').get('document:%')).toEqual({ count: 1 });
  });

  it('refuses publication if the library item is archived during parsing', async () => {
    const document = await importDocument();
    parse.mockImplementationOnce(async (input) => {
      const item = repository.library.get(document.libraryItemId);
      repository.library.archive(item.id, item.revision, true);
      return await parsedOutput(input);
    });
    expect(await service.parse(document.id)).toMatchObject({ status: 'failed', activeParseId: null, currentParseId: null, error: 'research_library_item_archived' });
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents').get()).toEqual({ count: 0 });
  });

  it('rejects unlisted resource paths and modified source or preview bytes', async () => {
    const document = await importDocument();
    parse.mockImplementationOnce(async (input) => ({ ...await parsedOutput(input), assets: [{ path: '../../outside.png', kind: 'page', page: 1 }] }));
    expect(await service.parse(document.id)).toMatchObject({ status: 'failed', currentParseId: null, error: 'research_relative_path_invalid' });
    const ready = await service.parse(document.id);
    if (ready.currentParseId === null) throw new Error('parse_id_required');
    const content = service.parsed(document.id, ready.currentParseId).content;
    await expect(service.asset({ documentId: document.id, parseId: ready.currentParseId, assetId: 'not-listed', sha256: content.assets[0].sha256 })).rejects.toThrow('research_document_asset_not_found');
    await writeFile(join(root, `library/documents/${document.id}/runs/${ready.currentParseId}/output/page-1.png`), 'changed preview');
    await expect(service.asset({ documentId: document.id, parseId: ready.currentParseId, assetId: 'asset_0', sha256: content.assets[0].sha256 })).rejects.toThrow('research_document_asset_changed');
    await writeFile(join(root, 'library', repository.documents.sourcePath(document.id)), 'changed original');
    await expect(service.source({ documentId: document.id, sourceHash: document.sourceHash })).rejects.toThrow('research_document_source_changed');
    expect(await service.parse(document.id)).toMatchObject({ status: 'failed', currentParseId: ready.currentParseId, error: 'research_document_source_changed' });
  });

  it('recovers interrupted runs without discarding a previous successful result', async () => {
    const document = await importDocument();
    const ready = await service.parse(document.id);
    repository.documents.begin(document.id, 'interrupted');
    const restarted = new ResearchRepository(db);
    restarted.documents.recover();
    expect(restarted.documents.get(document.id)).toMatchObject({ status: 'failed', currentParseId: ready.currentParseId, activeParseId: null, error: 'research_document_parse_interrupted' });
    expect(restarted.documents.runs(document.id)[0]).toMatchObject({ id: 'interrupted', status: 'failed', error: 'research_document_parse_interrupted' });
  });

  it('adds document storage to v6 without changing the existing library', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.pragma('foreign_keys = ON');
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 6) });
      const item = new ResearchRepository(legacy).library.import([libraryEntry()], null).items[0];
      applyResearchDatabaseSchema(legacy);
      applyResearchDatabaseSchema(legacy);
      const upgraded = new ResearchRepository(legacy);
      expect(upgraded.library.get(item.id)).toEqual(item);
      expect(upgraded.documents.list(item.id)).toEqual([]);
    } finally { legacy.close(); }
  });
});
