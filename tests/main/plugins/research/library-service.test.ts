import Database from 'better-sqlite3';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchLibraryService } from '../../../../src/main/plugins/research/library-service';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import type { ResearchToolchain } from '../../../../src/main/plugins/research/toolchain';
import { libraryEntry } from './library-fixtures';

type LibraryTools = Pick<ResearchToolchain, 'readBibliography' | 'normalizeBibliography' | 'writeBibliography'>;
let db: Database.Database;
let repository: ResearchRepository;
let root: string;
let service: ResearchLibraryService;
let projectId: string;
const read = vi.fn<LibraryTools['readBibliography']>();
const normalize = vi.fn<LibraryTools['normalizeBibliography']>();
const write = vi.fn<LibraryTools['writeBibliography']>();
const fetchDoi = vi.fn<NonNullable<ConstructorParameters<typeof ResearchLibraryService>[3]>>();
const record = () => ({ record: libraryEntry().metadata, citationKey: 'original', projectId });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-library-service-')));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Library', description: '', workspacePath: '/tmp/library-service.test-1' }).id;
  read.mockReset().mockResolvedValue([libraryEntry().bibliography]);
  normalize.mockReset().mockResolvedValue([libraryEntry().bibliography]);
  write.mockReset().mockResolvedValue({ filename: 'references.bib', content: '@article{original,title={Evidence study}}' });
  fetchDoi.mockReset().mockImplementation(async () => Response.json({ type: 'journal-article', title: 'Evidence study', DOI: '10.1234/paper', ISSN: ['1745-2473', '1745-2481'] }));
  service = new ResearchLibraryService(repository.library, { readBibliography: read, normalizeBibliography: normalize, writeBibliography: write }, join(root, 'library'), fetchDoi);
});
afterEach(async () => { await service.shutdown(); db.close(); await rm(root, { recursive: true, force: true }); });

describe('research library service', () => {
  it('imports normalized search results with the requested citation key and cleans temporary jobs', async () => {
    normalize.mockImplementationOnce(async (input) => {
      expect(JSON.parse(await readFile(input.sourcePath, 'utf8'))).toEqual([{ metadata: record().record, citationKey: 'original' }]);
      return [libraryEntry().bibliography];
    });
    const imported = await service.importRecord(record());
    expect(imported).toMatchObject({ createdCount: 1, duplicateCount: 0 });
    expect(imported.items[0]).toMatchObject({ projectIds: [projectId], bibliography: { citationKey: 'original' } });
    expect(await readdir(join(root, 'library'))).toEqual([]);
  });

  it('copies a bibliography before parsing and gives equivalent field orders the same local identity', async () => {
    const source = join(root, 'source.bib');
    const content = '@article{original,title={Evidence study}}';
    await writeFile(source, content);
    const firstEntry = libraryEntry({ doi: null }).bibliography;
    read.mockImplementationOnce(async (input) => {
      expect(input.sourcePath).not.toBe(source);
      expect(await readFile(input.sourcePath, 'utf8')).toBe(content);
      expect(input.format).toBe('biblatex');
      return [firstEntry];
    });
    const imported = await service.importFile({ sourcePath: source, format: 'biblatex', projectId });
    const reverse = { ...firstEntry, fields: Object.fromEntries(Object.entries(firstEntry.fields).reverse()) };
    read.mockResolvedValueOnce([reverse]);
    const repeated = await service.importFile({ sourcePath: source, format: 'biblatex', projectId });
    expect(repeated).toMatchObject({ createdCount: 0, duplicateCount: 1 });
    expect(repeated.items[0].id).toBe(imported.items[0].id);
    expect(await readFile(source, 'utf8')).toBe(content);
  });

  it('rejects symlink sources and invalid project destinations before invoking bibliography tools', async () => {
    const source = join(root, 'real.bib');
    const link = join(root, 'link.bib');
    await writeFile(source, '@article{key,title={Title}}');
    await symlink(source, link);
    await expect(service.importFile({ sourcePath: link, format: 'bibtex', projectId })).rejects.toThrow('research_bibliography_source_invalid');
    await expect(service.importRecord({ ...record(), projectId: 'missing' })).rejects.toThrow('research_project_not_found');
    expect(read).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
  });

  it('distinguishes local CSL editions and editors while ignoring object key order', async () => {
    const source = join(root, 'source.json');
    await writeFile(source, '[]');
    const base = libraryEntry({ doi: null }).bibliography;
    const first = { ...base, csl: { id: 'book', type: 'book', title: base.title, edition: '1', editor: [{ family: 'Smith' }] } };
    const second = { ...base, csl: { ...first.csl, edition: '2', editor: [{ family: 'Jones' }] } };
    read.mockResolvedValueOnce([first]);
    const imported = await service.importFile({ sourcePath: source, format: 'csl-json', projectId });
    read.mockResolvedValueOnce([second]);
    const different = await service.importFile({ sourcePath: source, format: 'csl-json', projectId });
    expect(different.createdCount).toBe(1);
    expect(different.items[0].id).not.toBe(imported.items[0].id);
    expect(different.items[0].bibliography.csl?.edition).toBe('2');
    read.mockResolvedValueOnce([{ ...first, csl: Object.fromEntries(Object.entries(first.csl).reverse()) }]);
    const repeated = await service.importFile({ sourcePath: source, format: 'csl-json', projectId });
    expect(repeated).toMatchObject({ createdCount: 0, duplicateCount: 1 });
    expect(repeated.items[0].id).toBe(imported.items[0].id);
  });

  it('maps Crossref types at the DOI boundary and supplies a stable citation key', async () => {
    let payload: Record<string, unknown>[] = [];
    read.mockImplementation(async (input) => {
      payload = JSON.parse(await readFile(input.sourcePath, 'utf8')) as Record<string, unknown>[];
      expect(input.format).toBe('csl-json');
      return [{ ...libraryEntry().bibliography, citationKey: String(payload[0].id) }];
    });
    const imported = await service.importDoi({ doi: 'https://doi.org/10.1234/PAPER', projectId });
    expect(fetchDoi).toHaveBeenCalledWith('https://doi.org/10.1234%2Fpaper', expect.objectContaining({
      headers: { accept: 'application/vnd.citationstyles.csl+json', 'user-agent': 'Roc-research/0.1' }, signal: expect.any(AbortSignal)
    }));
    expect(payload[0]).toMatchObject({ type: 'article-journal', DOI: '10.1234/paper', ISSN: '1745-2473, 1745-2481' });
    expect(payload[0].id).toBe(payload[0]['citation-key']);
    expect(imported.items[0].metadata).toMatchObject({ source: 'doi', externalId: '10.1234/paper', doi: '10.1234/paper' });
    const repeated = await service.importDoi({ doi: 'doi:10.1234/paper', projectId });
    expect(repeated.items[0].bibliography.citationKey).toBe(imported.items[0].bibliography.citationKey);
    expect(repeated.duplicateCount).toBe(1);
  });

  it('rejects DOI HTTP errors, mismatched identities and oversized streams without partial imports', async () => {
    const cases = [
      { response: new Response('Missing', { status: 404 }), error: 'research_doi_http_404' },
      { response: new Response('<html>Unavailable</html>'), error: 'research_doi_response_invalid' },
      { response: Response.json({ DOI: '10.1234/paper', ISSN: [42] }), error: 'research_doi_response_invalid' },
      { response: Response.json({ DOI: '10.1234/other', title: 'Wrong' }), error: 'research_doi_response_mismatch' },
      { response: new Response('x'.repeat(4 * 1024 * 1024 + 1)), error: 'research_doi_response_too_large' }
    ];
    for (const entry of cases) {
      fetchDoi.mockResolvedValueOnce(entry.response);
      await expect(service.importDoi({ doi: '10.1234/paper', projectId })).rejects.toThrow(entry.error);
    }
    expect(read).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS count FROM research_library').get()).toEqual({ count: 0 });
    expect(await readdir(join(root, 'library'))).toEqual([]);
  });

  it('never commits a late bibliography result after shutdown and refuses later operations', async () => {
    let finish!: (entries: Awaited<ReturnType<LibraryTools['normalizeBibliography']>>) => void;
    normalize.mockImplementationOnce(async () => await new Promise((resolve) => { finish = resolve; }));
    const pending = service.importRecord(record());
    await vi.waitFor(() => expect(normalize).toHaveBeenCalledOnce());
    const closing = service.shutdown();
    expect(normalize.mock.calls[0][0].signal?.aborted).toBe(true);
    finish([libraryEntry().bibliography]);
    await expect(pending).rejects.toThrow('research_library_cancelled');
    await closing;
    await expect(service.importRecord(record())).rejects.toThrow('research_library_closed');
    expect(db.prepare('SELECT count(*) AS count FROM research_library').get()).toEqual({ count: 0 });
    expect(await readdir(join(root, 'library'))).toEqual([]);
  });

  it('rechecks the destination when it is archived while parsing', async () => {
    normalize.mockImplementationOnce(async () => {
      db.prepare("UPDATE research_projects SET status = 'archived' WHERE id = ?").run(projectId);
      return [libraryEntry().bibliography];
    });
    await expect(service.importRecord(record())).rejects.toThrow('research_project_archived');
    expect(db.prepare('SELECT count(*) AS count FROM research_library').get()).toEqual({ count: 0 });
  });

  it('exports a bibliography snapshot and refuses archived or duplicate selections', async () => {
    const item = repository.library.import([libraryEntry()], projectId).items[0];
    write.mockImplementationOnce(async (input) => {
      expect(JSON.parse(await readFile(input.sourcePath, 'utf8'))).toEqual([item.bibliography]);
      return { filename: 'references.bib', content: '@article{original,title={Evidence study}}' };
    });
    expect(await service.export({ ids: [item.id], format: 'bibtex' })).toEqual({ format: 'bibtex', filename: 'references.bib', content: '@article{original,title={Evidence study}}' });
    await expect(service.export({ ids: [item.id, item.id], format: 'bibtex' })).rejects.toThrow('research_library_selection_duplicate');
    repository.library.archive(item.id, item.revision, true);
    await expect(service.export({ ids: [item.id], format: 'bibtex' })).rejects.toThrow('research_library_item_archived');
    expect(write).toHaveBeenCalledOnce();
  });
});
