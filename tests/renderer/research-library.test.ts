import { describe, expect, it, vi } from 'vitest';

import { createResearchLibraryProjection } from '../../src/renderer/views/research/research-library';
import type { ResearchLibraryAdapter } from '../../src/renderer/views/research/research-library';
import type { ResearchDocument, ResearchDocumentParse, ResearchLibraryItem, ResearchLiterature } from '../../src/shared/types';

describe('research library projection', () => {
  it('searches literature, imports a hit, and opens parsed reader text', async () => {
    const record = literature();
    const item = libraryItem(record);
    const adapter = createAdapter({
      search: [record],
      items: [item],
      documents: [document(item.id)],
      content: parse()
    });
    const library = createResearchLibraryProjection(adapter);
    library.setProject('research_1');
    library.setQuery('evidence graph');
    await library.search();
    expect(adapter.searchLiterature).toHaveBeenCalledWith(expect.objectContaining({ query: 'evidence graph' }));
    expect(library.getSnapshot().results).toHaveLength(1);
    await library.importRecord(record);
    expect(adapter.importRecord).toHaveBeenCalledWith(expect.objectContaining({
      record, citationKey: '101234paper', projectId: 'research_1'
    }));
    await library.open(item);
    expect(library.getSnapshot().openContent?.content.content).toBe('Measured improvement.');
  });

  it('imports a bibliography file and exports selected records', async () => {
    const record = literature({ id: 'local:1', source: 'local' });
    const item = libraryItem(record);
    const adapter = createAdapter({ items: [item] });
    adapter.selectFile = vi.fn(async () => '/tmp/library.bib');
    adapter.exportBibliography = vi.fn(async () => ({
      format: 'bibtex' as const, filename: 'library.bib', content: '@article{doe2026,title={Measured study}}'
    }));
    const library = createResearchLibraryProjection(adapter);
    library.setProject('research_1');
    await library.importBibliography();
    expect(adapter.importBibliography).toHaveBeenCalledWith({
      sourcePath: '/tmp/library.bib', format: 'bibtex', projectId: 'research_1'
    });
    library.toggleSelected(item.id);
    await library.exportBibliography();
    expect(adapter.exportBibliography).toHaveBeenCalledWith({ ids: [item.id], format: 'bibtex' });
    expect(library.getSnapshot().exportPreview?.content).toContain('@article{doe2026,title={Measured study}}');
  });

  it('imports a PDF attachment into the open item and shows parsed text', async () => {
    const record = literature();
    const item = libraryItem(record);
    const imported = document(item.id, { status: 'imported', currentParseId: null });
    const ready = document(item.id);
    const adapter = createAdapter({ items: [item], documents: [] });
    adapter.selectFile = vi.fn(async () => '/tmp/paper.pdf');
    adapter.importDocument = vi.fn(async () => imported);
    adapter.parseDocument = vi.fn(async () => ready);
    adapter.listDocuments = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([ready]);
    adapter.getDocumentContent = vi.fn(async () => parse());
    const library = createResearchLibraryProjection(adapter);
    library.setProject('research_1');
    await library.open(item);
    await library.importDocument();
    expect(adapter.importDocument).toHaveBeenCalledWith({
      target: 'library-item', sourcePath: '/tmp/paper.pdf', libraryItemId: item.id, projectId: 'research_1'
    });
    expect(adapter.parseDocument).toHaveBeenCalledWith({ documentId: imported.id });
    expect(library.getSnapshot().openContent?.content.content).toBe('Measured improvement.');
  });
});

function createAdapter(overrides: {
  search?: ResearchLiterature[];
  items?: ResearchLibraryItem[];
  documents?: ResearchDocument[];
  content?: ResearchDocumentParse;
}): ResearchLibraryAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    searchLiterature: vi.fn(async () => overrides.search ?? []),
    listLibrary: vi.fn(async () => overrides.items ?? []),
    importDoi: vi.fn(),
    importBibliography: vi.fn(),
    exportBibliography: vi.fn(),
    importRecord: vi.fn(),
    linkItem: vi.fn(),
    listDocuments: vi.fn(async () => overrides.documents ?? []),
    getDocumentContent: vi.fn(async () => overrides.content ?? parse()),
    importDocument: vi.fn(),
    parseDocument: vi.fn(),
    selectFile: vi.fn(async () => null)
  };
}

function literature(overrides: Partial<ResearchLiterature> = {}): ResearchLiterature {
  return {
    id: 'openalex:1', source: 'openalex', externalId: '1', doi: '10.1234/paper', title: 'Measured study',
    authors: ['Jane Doe'], abstract: 'Measured improvement.', publishedYear: 2026, citationCount: 1,
    url: null, openAccessUrl: null, importedAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides
  };
}

function libraryItem(record: ResearchLiterature): ResearchLibraryItem {
  return {
    id: 'lib_1', metadata: record, bibliography: {
      citationKey: 'doe2026', entryType: 'article', fields: { title: record.title }, preambles: [], csl: null,
      title: record.title, authors: record.authors, doi: record.doi, publishedYear: 2026, abstract: record.abstract, url: null
    },
    sources: [], projectIds: ['research_1'], revision: 1, archived: false, createdAt: record.importedAt, updatedAt: record.updatedAt
  };
}

function document(libraryItemId: string, overrides: Partial<ResearchDocument> = {}): ResearchDocument {
  return {
    id: 'doc_1', libraryItemId, filename: 'paper.pdf', mediaType: 'application/pdf', sourceHash: 'a'.repeat(64),
    size: 12, status: 'ready', currentParseId: 'parse_1', activeParseId: null, error: null,
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides
  };
}

function parse(): ResearchDocumentParse {
  return {
    run: { id: 'parse_1', documentId: 'doc_1', status: 'ready', error: null, createdAt: '2026-09-14T00:00:00.000Z', finishedAt: '2026-09-14T00:00:00.000Z' },
    content: {
      sourceHash: 'a'.repeat(64), parserVersion: 'roc-pdf-1', pageCount: 1, content: 'Measured improvement.', warnings: [],
      assets: [], blocks: [{ id: 'b1', kind: 'paragraph', label: 'Body', text: 'Measured improvement.', locator: 'page 1', imageAssetId: null, locations: [] }]
    }
  };
}
