import { XMLParser } from 'fast-xml-parser';

import type { ResearchLiterature, ResearchLiteratureSearchRequest } from '../../../shared/types';
import { literatureIdentity, normalizeResearchDoi, referenceKey } from './literature-identity';
import type { BibliographyEntry } from './library-repository';
import type { ResearchRepository } from './repository';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class LiteratureSearchService {
  private readonly xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  async search(request: ResearchLiteratureSearchRequest): Promise<ResearchLiterature[]> {
    const results = await Promise.allSettled(
      request.sources.map((source) => this.searchSource(source, request.query, request.limit))
    );
    const records = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    if (records.length === 0) {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      throw failure?.reason instanceof Error ? failure.reason : new Error('literature_search_empty');
    }
    return dedupeLiterature(records).slice(0, request.limit);
  }

  searchAndStore(repository: ResearchRepository, request: ResearchLiteratureSearchRequest): Promise<ResearchLiterature[]> {
    return this.search(request).then((records) => {
      for (const record of records) ingestLiteratureRecord(repository, record);
      return records;
    });
  }

  private async searchSource(
    source: ResearchLiteratureSearchRequest['sources'][number],
    query: string,
    limit: number
  ): Promise<ResearchLiterature[]> {
    switch (source) {
      case 'openalex': return this.searchOpenAlex(query, limit);
      case 'crossref': return this.searchCrossref(query, limit);
      case 'semantic_scholar': return this.searchSemanticScholar(query, limit);
      case 'arxiv': return this.searchArxiv(query, limit);
      case 'pubmed': return this.searchEuropePmc(query, limit, 'pubmed');
      case 'europe_pmc': return this.searchEuropePmc(query, limit, 'europe_pmc');
      case 'local': return [];
    }
  }

  private async searchOpenAlex(query: string, limit: number): Promise<ResearchLiterature[]> {
    const payload = await this.getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}`) as OpenAlexPayload;
    return (payload.results ?? []).map((item) => ({
      id: `openalex:${item.id}`,
      source: 'openalex' as const,
      externalId: item.id,
      doi: optionalResearchDoi(item.doi),
      title: item.title ?? 'Untitled work',
      authors: (item.authorships ?? []).map((author) => author.author?.display_name ?? '').filter(Boolean),
      abstract: invertAbstract(item.abstract_inverted_index),
      publishedYear: item.publication_year ?? null,
      citationCount: item.cited_by_count ?? null,
      url: item.id ?? null,
      openAccessUrl: item.open_access?.oa_url ?? null,
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  private async searchCrossref(query: string, limit: number): Promise<ResearchLiterature[]> {
    const payload = await this.getJson(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}`) as CrossrefPayload;
    return (payload.message?.items ?? []).map((item) => ({
      id: `crossref:${item.DOI ?? item.URL ?? item.title?.[0] ?? crypto.randomUUID()}`,
      source: 'crossref' as const,
      externalId: item.DOI ?? item.URL ?? item.title?.[0] ?? crypto.randomUUID(),
      doi: optionalResearchDoi(item.DOI),
      title: item.title?.[0] ?? 'Untitled work',
      authors: (item.author ?? []).map((author) => [author.given, author.family].filter(Boolean).join(' ')),
      abstract: item.abstract ?? null,
      publishedYear: item.published?.['date-parts']?.[0]?.[0] ?? null,
      citationCount: null,
      url: item.URL ?? null,
      openAccessUrl: null,
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  private async searchSemanticScholar(query: string, limit: number): Promise<ResearchLiterature[]> {
    const payload = await this.getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,abstract,year,citationCount,externalIds,openAccessPdf,url`) as SemanticScholarPayload;
    return (payload.data ?? []).map((item) => ({
      id: `semantic_scholar:${item.paperId}`,
      source: 'semantic_scholar' as const,
      externalId: item.paperId,
      doi: optionalResearchDoi(item.externalIds?.DOI),
      title: item.title ?? 'Untitled work',
      authors: (item.authors ?? []).map((author) => author.name),
      abstract: item.abstract ?? null,
      publishedYear: item.year ?? null,
      citationCount: item.citationCount ?? null,
      url: item.url ?? null,
      openAccessUrl: item.openAccessPdf?.url ?? null,
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  private async searchArxiv(query: string, limit: number): Promise<ResearchLiterature[]> {
    const xml = await this.getText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`);
    const payload = this.xmlParser.parse(xml) as { feed?: { entry?: ArxivEntry | ArxivEntry[] } };
    const entries = normalizeArray(payload.feed?.entry);
    return entries.map((item) => ({
      id: `arxiv:${textValue(item.id)}`,
      source: 'arxiv' as const,
      externalId: textValue(item.id),
      doi: null,
      title: normalizeWhitespace(textValue(item.title)) || 'Untitled work',
      authors: normalizeArray(item.author).map((author) => textValue(author.name)).filter(Boolean),
      abstract: normalizeWhitespace(textValue(item.summary)) || null,
      publishedYear: yearFromDate(textValue(item.published)),
      citationCount: null,
      url: textValue(item.id) || null,
      openAccessUrl: textValue(item.id) || null,
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  private async searchEuropePmc(query: string, limit: number, source: 'pubmed' | 'europe_pmc'): Promise<ResearchLiterature[]> {
    const payload = await this.getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${limit}`) as EuropePmcPayload;
    return (payload.resultList?.result ?? []).map((item) => ({
      id: `${source}:${item.id ?? item.pmid ?? crypto.randomUUID()}`,
      source,
      externalId: item.id ?? item.pmid ?? crypto.randomUUID(),
      doi: optionalResearchDoi(item.doi),
      title: item.title ?? 'Untitled work',
      authors: item.authorString === undefined ? [] : item.authorString.split(',').map((author) => author.trim()).filter(Boolean),
      abstract: item.abstractText ?? null,
      publishedYear: item.pubYear === undefined ? null : Number(item.pubYear),
      citationCount: item.citedByCount ?? null,
      url: item.id === undefined ? null : `https://europepmc.org/article/${item.source ?? 'MED'}/${item.id}`,
      openAccessUrl: item.isOpenAccess === 'Y' && item.id !== undefined ? `https://europepmc.org/article/${item.source ?? 'MED'}/${item.id}` : null,
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`literature_provider_http_${response.status}`);
    return response.json();
  }

  private async getText(url: string): Promise<string> {
    const response = await this.fetchImpl(url, { headers: { accept: 'application/atom+xml, application/xml, text/xml' } });
    if (!response.ok) throw new Error(`literature_provider_http_${response.status}`);
    return response.text();
  }
}

function dedupeLiterature(records: ResearchLiterature[]): ResearchLiterature[] {
  const byIdentity = new Map<string, ResearchLiterature>();
  for (const record of records) {
    const identity = literatureIdentity({ doi: record.doi, source: record.source, externalId: record.externalId });
    if (!byIdentity.has(identity)) byIdentity.set(identity, record);
  }
  return Array.from(byIdentity.values());
}

function optionalResearchDoi(doi: string | null | undefined): string | null {
  if (doi === undefined || doi === null || doi.trim().length === 0) return null;
  return normalizeResearchDoi(doi);
}

function invertAbstract(value: Record<string, number[]> | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const words: Array<{ word: string; position: number }> = [];
  for (const [word, positions] of Object.entries(value)) for (const position of positions) words.push({ word, position });
  words.sort((left, right) => left.position - right.position);
  return words.map((item) => item.word).join(' ') || null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function yearFromDate(value: string): number | null {
  const match = value.match(/\b(19|20)\d{2}\b/u);
  return match === null ? null : Number(match[0]);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeArray<T>(value: T | T[] | null | undefined): T[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

type OpenAlexPayload = { results?: Array<{ id: string; doi?: string | null; title?: string | null; authorships?: Array<{ author?: { display_name?: string | null } }>; abstract_inverted_index?: Record<string, number[]> | null; publication_year?: number | null; cited_by_count?: number | null; open_access?: { oa_url?: string | null } }> };
type CrossrefPayload = { message?: { items?: Array<{ DOI?: string; URL?: string; title?: string[]; author?: Array<{ given?: string; family?: string }>; abstract?: string; published?: { 'date-parts'?: number[][] } }> } };
type SemanticScholarPayload = { data?: Array<{ paperId: string; title?: string; authors?: Array<{ name: string }>; abstract?: string | null; year?: number | null; citationCount?: number | null; externalIds?: { DOI?: string }; openAccessPdf?: { url?: string | null }; url?: string | null }> };
type ArxivEntry = { id?: string; title?: string; summary?: string; published?: string; author?: { name?: string } | Array<{ name?: string }> };
type EuropePmcPayload = { resultList?: { result?: Array<{ id?: string; pmid?: string; doi?: string; title?: string; authorString?: string; abstractText?: string; pubYear?: string; citedByCount?: number; isOpenAccess?: string; source?: string }> } };

export function ingestLiteratureRecord(repository: ResearchRepository, record: ResearchLiterature): void {
  const identity = literatureIdentity(record);
  const bibliography = bibliographyFromRecord(record, identity);
  repository.library.import([{ metadata: record, bibliography }], null);
}

function bibliographyFromRecord(record: ResearchLiterature, identity: string): BibliographyEntry {
  return {
    citationKey: referenceKey(identity),
    entryType: 'article',
    preambles: [],
    csl: null,
    title: record.title,
    authors: record.authors,
    doi: record.doi,
    publishedYear: record.publishedYear,
    abstract: record.abstract,
    url: record.url,
    fields: {
      title: record.title,
      ...(record.authors.length === 0 ? {} : { author: record.authors.join(' and ') }),
      ...(record.doi === null ? {} : { doi: record.doi }),
      ...(record.publishedYear === null ? {} : { year: String(record.publishedYear) }),
      ...(record.abstract === null ? {} : { abstract: record.abstract }),
      ...(record.url === null ? {} : { url: record.url })
    }
  };
}
