import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { researchLiteratureSchema } from '../../../shared/schemas/research';
import { literatureNetworkSourceSchema, type LiteratureSearchInput, type LiteratureSearchResult } from '../../../shared/schemas/literature-import';

import type { ResearchLiterature } from '../../../shared/types';
import { normalizeResearchDoi } from './literature-identity';
import { fuseLiterature, literatureSourcePriority } from './literature-fusion';
import { arxivSearchPayload, crossrefSearchPayload, europePmcSearchPayload, openAlexSearchPayload, semanticScholarSearchPayload } from './literature-provider-schemas';
import { LiteratureResponseCache, type CachedLiteratureResponse } from './literature-response-cache';
import { createLiteratureProviderGovernor, LiteratureProviderAdmissionError, literatureProviderHosts, type LiteratureProviderGovernor } from './literature-provider-governor';
import { betterBibtexKey } from './cite-key';
import type { BibliographyEntry } from './library-repository';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ProviderContext = {signal: AbortSignal; receipts: LiteratureSearchResult['sources'][number]['requests']; projectId: string | null;
  cacheHit: CachedLiteratureResponse | null; pendingCache: {key: string; response: CachedLiteratureResponse} | null;
  fetchedAt: string | null; host: string; release: (() => void) | null};

export class LiteratureSearchService {
  private readonly xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  private readonly cache = new LiteratureResponseCache({maxEntries: 32, maxBytes: 8 * 1024 * 1024, ttlMs: 5 * 60_000}, Date.now);
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<Awaited<ReturnType<LiteratureSearchService['executeSearch']>>>>();

  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly governor: LiteratureProviderGovernor = createLiteratureProviderGovernor()) {}

  private readonly requests = new AsyncLocalStorage<ProviderContext>();

  async searchDetailed(request: LiteratureSearchInput, signal?: AbortSignal): Promise<{
    records: ResearchLiterature[]; sources: LiteratureSearchResult['sources']; status: LiteratureSearchResult['status']; truncated: boolean; warnings: string[];
  }> {
    this.lifetime.signal.throwIfAborted();
    const pending = this.executeSearch(request, signal);
    this.active.add(pending);
    try { return await pending; }
    finally { this.active.delete(pending); }
  }

  async shutdown(): Promise<void> {
    this.lifetime.abort(new Error('literature_service_closed'));
    await Promise.allSettled([...this.active]);
    this.cache.clear();
  }

  private async executeSearch(request: LiteratureSearchInput, signal?: AbortSignal): Promise<{
    records: ResearchLiterature[]; sources: LiteratureSearchResult['sources']; status: LiteratureSearchResult['status']; truncated: boolean; warnings: string[];
  }> {
    const deadline = AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal]), AbortSignal.timeout(30_000)]);
    const projectId = request.projectId ?? null;
    const sources: LiteratureSearchResult['sources'] = [];
    const records: ResearchLiterature[] = [];
    const requestedSources = z.array(literatureNetworkSourceSchema).min(1).parse(request.sources);
    const selected = literatureSourcePriority.filter(source => requestedSources.includes(source));
    for (let offset = 0; offset < selected.length; offset += 3) {
      await Promise.all(selected.slice(offset, offset + 3).map(async (source) => {
        const providerSignal = AbortSignal.any([deadline, AbortSignal.timeout(15_000)]);
        const receipts: ProviderContext['receipts'] = [];
        const host = literatureProviderHosts[source];
        const providerContext: ProviderContext = {signal: providerSignal, receipts, projectId,
          cacheHit: null, pendingCache: null, fetchedAt: null, host, release: null};
        const cacheObservation = (): LiteratureSearchResult['sources'][number]['cache'] => providerContext.cacheHit === null ?
          {state: 'miss'} : {state: 'hit', fetchedAt: providerContext.cacheHit.fetchedAt, responseHash: providerContext.cacheHit.responseHash};
        try {
          const found = await this.requests.run(providerContext, () => this.searchSource(source, request.query, request.limit));
          const valid = found.map((record) => researchLiteratureSchema.parse(record));
          providerSignal.throwIfAborted();
          if (providerContext.cacheHit === null) this.governor.success(host);
          if (providerContext.pendingCache !== null) this.cache.put(providerContext.pendingCache.key, providerContext.pendingCache.response);
          records.push(...valid);
          sources.push({ source, status: valid.length === 0 ? 'empty' : 'ok', returnedCount: valid.length,
            errorCode: null, retryAfterMs: null, requests: receipts, cache: cacheObservation(), governance: this.governor.observe(host) });
        } catch (error) {
          this.lifetime.signal.throwIfAborted();
          signal?.throwIfAborted();
          const rateLimited = error instanceof ProviderError && error.status === 429;
          const invalidPayload = error instanceof z.ZodError ||
            error instanceof Error && error.message === 'literature_provider_response_invalid';
          if (invalidPayload) this.governor.failure(host, null);
          sources.push({ source, status: providerSignal.aborted ? 'timeout' : rateLimited ? 'rate_limited' : 'error', returnedCount: 0,
            errorCode: providerSignal.aborted ? 'literature_provider_timeout' : rateLimited ? 'literature_provider_rate_limited' :
              error instanceof LiteratureProviderAdmissionError ? error.code :
                invalidPayload ? 'literature_provider_response_invalid' : 'literature_provider_error',
            retryAfterMs: error instanceof ProviderError || error instanceof LiteratureProviderAdmissionError ? error.retryAfterMs : null,
            requests: receipts, cache: cacheObservation(), governance: this.governor.observe(host) });
          return undefined;
        } finally { providerContext.release?.(); }
        return undefined;
      }));
    }
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    // Promise completion order must not change candidate ordering or identity.
    records.sort((a, b) => selected.indexOf(a.source as typeof selected[number]) - selected.indexOf(b.source as typeof selected[number]));
    sources.sort((a, b) => selected.indexOf(a.source) - selected.indexOf(b.source));
    const failures = sources.filter((source) => source.status !== 'ok' && source.status !== 'empty').length;
    return { records, sources, status: failures === 0 ? 'complete' : failures === sources.length ? 'failed' : 'partial',
      truncated: fuseLiterature(records).length > request.limit, warnings: failures === 0 ? [] : ['部分来源不可用；结果不代表穷尽检索。'] };
  }

  private async searchSource(
    source: typeof literatureSourcePriority[number],
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
    }
  }

  private async searchOpenAlex(query: string, limit: number): Promise<ResearchLiterature[]> {
    const payload = openAlexSearchPayload.parse(await this.getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}&page=1`));
    const timestamp = this.providerTimestamp();
    return payload.results.map((item) => ({
      id: `openalex:${item.id}`,
      source: 'openalex' as const,
      externalId: item.id,
      doi: optionalResearchDoi(item.doi),
      title: item.title,
      authors: (item.authorships ?? []).map((author) => author.author?.display_name ?? '').filter(Boolean),
      abstract: invertAbstract(item.abstract_inverted_index),
      publishedYear: item.publication_year ?? null,
      citationCount: item.cited_by_count ?? null,
      url: item.id ?? null,
      openAccessUrl: item.open_access?.oa_url ?? null,
      importedAt: timestamp,
      updatedAt: timestamp
    }));
  }

  private async searchCrossref(query: string, limit: number): Promise<ResearchLiterature[]> {
    const payload = crossrefSearchPayload.parse(await this.getJson(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&offset=0`));
    const timestamp = this.providerTimestamp();
    return payload.message.items.map((item) => ({
      id: `crossref:${item.DOI}`,
      source: 'crossref' as const,
      externalId: item.DOI,
      doi: optionalResearchDoi(item.DOI),
      title: item.title[0],
      authors: (item.author ?? []).map((author) => [author.given, author.family].filter(Boolean).join(' ')),
      abstract: item.abstract ?? null,
      publishedYear: item.published?.['date-parts']?.[0]?.[0] ?? null,
      citationCount: null,
      url: item.URL ?? null,
      openAccessUrl: null,
      importedAt: timestamp,
      updatedAt: timestamp
    }));
  }

  private async searchSemanticScholar(query: string, limit: number): Promise<ResearchLiterature[]> {
    const payload = semanticScholarSearchPayload.parse(await this.getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=0&fields=title,authors,abstract,year,citationCount,externalIds,openAccessPdf,url`));
    const timestamp = this.providerTimestamp();
    return payload.data.map((item) => ({
      id: `semantic_scholar:${item.paperId}`,
      source: 'semantic_scholar' as const,
      externalId: item.paperId,
      doi: optionalResearchDoi(item.externalIds?.DOI),
      title: item.title,
      authors: (item.authors ?? []).map((author) => author.name),
      abstract: item.abstract ?? null,
      publishedYear: item.year ?? null,
      citationCount: item.citationCount ?? null,
      url: item.url ?? null,
      openAccessUrl: item.openAccessPdf?.url ?? null,
      importedAt: timestamp,
      updatedAt: timestamp
    }));
  }

  private async searchArxiv(query: string, limit: number): Promise<ResearchLiterature[]> {
    const xml = await this.getText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}&start=0`);
    if (XMLValidator.validate(xml) !== true) throw new Error('literature_provider_response_invalid');
    const payload = arxivSearchPayload.parse(this.xmlParser.parse(xml));
    const entries = normalizeArray(payload.feed.entry);
    const timestamp = this.providerTimestamp();
    return entries.map((item) => ({
      id: `arxiv:${item.id}`,
      source: 'arxiv' as const,
      externalId: item.id,
      doi: optionalResearchDoi(item.doi),
      title: normalizeWhitespace(item.title),
      authors: normalizeArray(item.author).map(author => author.name),
      abstract: normalizeWhitespace(item.summary),
      publishedYear: Number(item.published.slice(0, 4)),
      citationCount: null,
      url: item.id,
      openAccessUrl: item.id,
      importedAt: timestamp,
      updatedAt: timestamp
    }));
  }

  private async searchEuropePmc(query: string, limit: number, source: 'pubmed' | 'europe_pmc'): Promise<ResearchLiterature[]> {
    const medQuery = source === 'pubmed' ? `(${query}) AND SRC:MED` : query;
    const payload = europePmcSearchPayload.parse(await this.getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(medQuery)}&format=json&pageSize=${limit}&cursorMark=*`));
    const timestamp = this.providerTimestamp();
    return payload.resultList.result.map((item) => ({
      id: `${source}:${item.id}`,
      source,
      externalId: item.id,
      doi: optionalResearchDoi(item.doi),
      title: item.title,
      authors: item.authorString === undefined ? [] : item.authorString.split(',').map((author) => author.trim()).filter(Boolean),
      abstract: item.abstractText ?? null,
      publishedYear: item.pubYear === undefined ? null : Number(item.pubYear),
      citationCount: item.citedByCount ?? null,
      url: `https://europepmc.org/article/${item.source}/${item.id}`,
      openAccessUrl: item.isOpenAccess === 'Y' ? `https://europepmc.org/article/${item.source}/${item.id}` : null,
      importedAt: timestamp,
      updatedAt: timestamp
    }));
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.readResponse(url, 'application/json');
    try { return JSON.parse(response) as unknown; }
    catch (cause) { throw new Error('literature_provider_response_invalid', { cause }); }
  }

  private async getText(url: string): Promise<string> {
    return this.readResponse(url, 'application/atom+xml, application/xml, text/xml');
  }

  private async readResponse(url: string, accept: string): Promise<string> {
    const allowed = ['https://api.openalex.org/', 'https://api.crossref.org/', 'https://api.semanticscholar.org/', 'https://export.arxiv.org/', 'https://www.ebi.ac.uk/'];
    if (!allowed.some((prefix) => url.startsWith(prefix))) throw new Error('literature_provider_url_invalid');
    const context = this.requests.getStore();
    if (context === undefined) throw new Error('literature_provider_context_missing');
    context.signal.throwIfAborted();
    const key = JSON.stringify([context.projectId, url, accept]);
    const cached = this.cache.get(key);
    if (cached !== null) {
      context.cacheHit = cached;
      context.fetchedAt = cached.fetchedAt;
      return cached.body;
    }
    for (let attempt = 0; ; attempt += 1) {
      context.signal.throwIfAborted();
      try {
        context.release = await this.governor.acquire(context.host, context.signal);
        const response = await this.readAttempt(url, accept, context);
        context.pendingCache = {key, response};
        context.fetchedAt = response.fetchedAt;
        return response.body;
      }
      catch (error) {
        context.release?.();
        context.release = null;
        if (!(error instanceof ProviderError) || (error.status !== 429 && error.status < 500) || attempt >= 2) throw error;
        if (error.retryAfterMs === null) await delay(250 * 2 ** attempt, undefined, {signal: context.signal});
      }
    }
  }

  private providerTimestamp(): string {
    const context = this.requests.getStore();
    if (context === undefined || context.fetchedAt === null) throw new Error('literature_provider_timestamp_missing');
    return context.fetchedAt;
  }

  private async readAttempt(url: string, accept: string, context: ProviderContext): Promise<CachedLiteratureResponse> {
    const receipt: ProviderContext['receipts'][number] = {attempt: context.receipts.length + 1, method: 'GET', url,
      startedAt: new Date().toISOString(), endedAt: null, status: null, retryAfterMs: null, responseHash: null, errorCode: null};
    context.receipts.push(receipt);
    const {signal} = context;
    try {
      const response = await this.fetchImpl(url, {method: 'GET', headers: { accept }, signal, redirect: 'error'});
      receipt.status = response.status;
      this.governor.responseLimits(context.host, response.headers);
      if (!response.ok) {
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const retryAfterMs = header === null ? null : Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(header) - Date.now());
        await response.body?.cancel();
        receipt.retryAfterMs = retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : null;
        throw new ProviderError(response.status, receipt.retryAfterMs);
      }
      if (response.body === null) throw new Error('literature_provider_body_missing');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 4 * 1024 * 1024) throw new Error('literature_provider_response_too_large');
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      const bytes = Buffer.concat(chunks);
      receipt.responseHash = createHash('sha256').update(bytes).digest('hex');
      return {body: bytes.toString('utf8'), fetchedAt: new Date().toISOString(), responseHash: receipt.responseHash};
    } catch (error) {
      if (!signal.aborted || signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {
        this.governor.failure(context.host, error instanceof ProviderError ? error.retryAfterMs : null);
      }
      receipt.errorCode = signal.aborted ? 'literature_provider_timeout' :
        error instanceof ProviderError ? `literature_provider_http_${error.status}` : 'literature_provider_transport_error';
      throw error;
    } finally { receipt.endedAt = new Date().toISOString(); }
  }
}

class ProviderError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) { super(`literature_provider_http_${status}`); }
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

function normalizeArray<T>(value: T | T[] | null | undefined): T[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

/**
 * **引用键不再是身份哈希**。
 *
 * 键由 `cite-key.ts` 按 Better BibTeX 公式生成，并带上传入的已占用集合——同一批导入里
 * 两篇同作者同年同标题开头的文献会依次得到 `…a`、`…b`，而不是把冲突留到导出时才报
 * `research_export_citation_key_conflict`。
 */
export function bibliographyFromRecord(record: ResearchLiterature, taken: Set<string>): BibliographyEntry {
  return {
    citationKey: betterBibtexKey({ authors: record.authors, publishedYear: record.publishedYear, title: record.title }, taken),
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
