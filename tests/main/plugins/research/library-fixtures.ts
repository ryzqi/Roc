import type { ResearchLiterature } from '../../../../src/shared/types';
import type { BibliographyEntry } from '../../../../src/main/plugins/research/library-repository';

export function libraryEntry(overrides: Partial<ResearchLiterature> = {}, fields: Record<string, string> = {}): {
  metadata: ResearchLiterature; bibliography: BibliographyEntry;
} {
  const metadata: ResearchLiterature = {
    id: 'crossref:paper', source: 'crossref', externalId: 'paper', doi: '10.1234/paper', title: 'Evidence study',
    authors: ['Jane Doe'], abstract: null, publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null,
    importedAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z', ...overrides
  };
  const bibliography: BibliographyEntry = {
    citationKey: 'original', entryType: 'article', preambles: [], csl: null,
    title: metadata.title, authors: metadata.authors, doi: metadata.doi, publishedYear: metadata.publishedYear,
    abstract: metadata.abstract, url: metadata.url,
    fields: { title: metadata.title, author: metadata.authors.join(' and '),
      ...(metadata.doi === null ? {} : { doi: metadata.doi }),
      ...(metadata.publishedYear === null ? {} : { year: String(metadata.publishedYear) }),
      ...(metadata.abstract === null ? {} : { abstract: metadata.abstract }),
      ...(metadata.url === null ? {} : { url: metadata.url }), ...fields }
  };
  return { metadata, bibliography };
}
