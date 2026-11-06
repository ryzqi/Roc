import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { researchLiteratureSchema } from '../../../shared/schemas/research';
import { literatureSearchInputSchema, type LiteraturePagePosition, type LiteratureSearchInput, type LiteratureSearchResult } from '../../../shared/schemas/literature-import';

import type { ResearchLiterature } from '../../../shared/types';
import { literatureIdentity, normalizeResearchDoi } from './literature-identity';
import {openAlexIdentifierObservations, semanticScholarIdentifierObservations} from './literature-provider-identifiers';
import {literatureRawIdentifiersSchema, type LiteratureIdentifierObservation, type LiteratureRawIdentifiers} from '../../../shared/schemas/literature-identifiers';
import { fuseLiterature, literatureSourcePriority, type RankedLiteratureRecord } from './literature-fusion';
import { arxivSearchPayload, crossrefSearchPayload, europePmcSearchPayload, openAlexSearchPayload, semanticScholarSearchPayload } from './literature-provider-schemas';
import { LiteratureResponseCache, type CachedLiteratureResponse } from './literature-response-cache';
import { createLiteratureProviderGovernor, LiteratureProviderAdmissionError, researchProviderHosts,
  type ResearchMetadataProvider, type LiteratureProviderGovernor } from './literature-provider-governor';
import { LiteratureRequestAuditError } from './literature-search-ledger';
import { betterBibtexKey } from './cite-key';
import {unknownLiteratureReview, openAlexReview, crossrefReview, arxivReview} from './literature-provider-review';
import {literatureReviewSchema, type LiteratureReview} from '../../../shared/schemas/literature-review';
import type { BibliographyEntry } from './library-repository';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type SourceOutcome = LiteratureSearchResult['sources'][number];
export type LiteratureProviderJsonReceipt = {
  fetchedAt: string | null; responseHash: string | null; cache: 'hit' | 'miss';
  requests: SourceOutcome['requests']; governance: SourceOutcome['governance'];
};
export type LiteratureProviderJsonResult<T> = LiteratureProviderJsonReceipt & (
  {status: 'ok'; value: T; errorCode: null; retryAfterMs: null} |
  {status: 'error'; value: null; errorCode: string; retryAfterMs: number | null}
);
type SearchOutcome = {
  records: RankedLiteratureRecord[]; sources: SourceOutcome[]; status: LiteratureSearchResult['status']; truncated: boolean; warnings: string[];
};
export type LiteratureRequestAudit = (phase: 'started' | 'finished', source: LiteratureSearchResult['sources'][number]['source'],
  receipt: LiteratureSearchResult['sources'][number]['requests'][number]) => void;
type ProviderContext = {signal: AbortSignal; receipts: LiteratureSearchResult['sources'][number]['requests']; projectId: string | null;
  cacheHit: CachedLiteratureResponse | null; pendingCache: {key: string; response: CachedLiteratureResponse} | null;
  fetchedAt: string | null; host: string; release: (() => void) | null;
  coverage: LiteratureSearchResult['sources'][number]['coverage'] | null;
  position: LiteraturePagePosition; rankOffset: number; url: string | null; visited: Set<string>;
  audit: ((phase: 'started' | 'finished', receipt: SourceOutcome['requests'][number]) => void) | undefined;
  identifiers: LiteratureIdentifierObservation[][] | null; rawIdentifiers: Array<LiteratureRawIdentifiers | null> | null;
  reviews: LiteratureReview[] | null};

export class LiteratureSearchService {
  private readonly xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  private readonly cache = new LiteratureResponseCache({maxEntries: 32, maxBytes: 8 * 1024 * 1024, ttlMs: 5 * 60_000}, Date.now);
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly governor: LiteratureProviderGovernor = createLiteratureProviderGovernor()) {}

  private readonly requests = new AsyncLocalStorage<ProviderContext>();

  async searchDetailed(input: unknown, signal?: AbortSignal, audit?: LiteratureRequestAudit): Promise<SearchOutcome> {
    this.lifetime.signal.throwIfAborted();
    const request = literatureSearchInputSchema.parse(input);
    const pending = this.executeSearch(request, signal, audit);
    this.active.add(pending);
    try { return await pending; }
    finally { this.active.delete(pending); }
  }

  async shutdown(): Promise<void> {
    this.lifetime.abort(new Error('literature_service_closed'));
    await Promise.allSettled([...this.active]);
    this.cache.clear();
  }

  /** Main-only provider reads share search admission, cache, receipts and shutdown. */
  async readProviderJson<T>(
    request: {source: ResearchMetadataProvider; url: string; projectId: string; timeoutMs: number},
    validate: (payload: unknown) => T, signal?: AbortSignal
  ): Promise<LiteratureProviderJsonResult<T>> {
    this.lifetime.signal.throwIfAborted();
    const pending = this.executeProviderJson(request, validate, signal);
    this.active.add(pending);
    try { return await pending; }
    finally { this.active.delete(pending); }
  }

  private async executeProviderJson<T>(
    request: {source: ResearchMetadataProvider; url: string; projectId: string; timeoutMs: number},
    validate: (payload: unknown) => T, signal: AbortSignal | undefined
  ): Promise<LiteratureProviderJsonResult<T>> {
    const host = researchProviderHosts[request.source];
    if (new URL(request.url).host !== host) throw new Error('literature_provider_url_invalid');
    const providerSignal = AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal]),
      AbortSignal.timeout(request.timeoutMs)]);
    const context: ProviderContext = {
      signal: providerSignal, receipts: [], projectId: request.projectId, host, audit: undefined,
      cacheHit: null, pendingCache: null, fetchedAt: null, release: null, coverage: null,
      position: {kind: 'offset', value: 0}, rankOffset: 0, url: null, visited: new Set(),
      identifiers: null, rawIdentifiers: null, reviews: null
    };
    const receipt = (): LiteratureProviderJsonReceipt => ({
      fetchedAt: context.fetchedAt,
      responseHash: context.cacheHit?.responseHash ?? context.pendingCache?.response.responseHash ??
        context.receipts.at(-1)?.responseHash ?? null,
      cache: context.cacheHit === null ? 'miss' : 'hit', requests: context.receipts, governance: this.governor.observe(host)
    });
    try {
      const value = await this.requests.run(context, async () => validate(await this.getJson(request.url)));
      providerSignal.throwIfAborted();
      if (context.cacheHit === null) this.governor.success(host);
      if (context.pendingCache !== null) this.cache.put(context.pendingCache.key, context.pendingCache.response);
      return {...receipt(), status: 'ok', value, errorCode: null, retryAfterMs: null};
    } catch (error) {
      this.lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      const invalid = error instanceof z.ZodError || error instanceof Error &&
        (error.message === 'literature_provider_response_invalid' || error.message === 'research_doi_invalid' ||
          error.message.startsWith('scholarly_provider_'));
      if (invalid) this.governor.failure(host, null);
      const errorCode = providerSignal.aborted ? 'literature_provider_timeout' :
        error instanceof LiteratureProviderAdmissionError ? error.code :
        error instanceof ProviderError ? `literature_provider_http_${error.status}` :
        invalid ? 'literature_provider_response_invalid' :
        error instanceof Error && error.message === 'literature_provider_response_too_large' ? error.message :
        'literature_provider_transport_error';
      return {...receipt(), status: 'error', value: null, errorCode,
        retryAfterMs: error instanceof ProviderError || error instanceof LiteratureProviderAdmissionError ? error.retryAfterMs : null};
    } finally { context.release?.(); context.release = null; }
  }

  private async executeSearch(request: LiteratureSearchInput, signal?: AbortSignal, audit?: LiteratureRequestAudit): Promise<SearchOutcome> {
    const deadline = AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal]), AbortSignal.timeout(30_000)]);
    const sources: LiteratureSearchResult['sources'] = [];
    const records: RankedLiteratureRecord[] = [];
    const selected = literatureSourcePriority.filter(source => request.sources.includes(source));
    for (let offset = 0; offset < selected.length; offset += 3) {
      const outcomes = await Promise.allSettled(selected.slice(offset, offset + 3)
        .map(source => this.executeSource(request, source, deadline, signal, audit)));
      const rejection = outcomes.find(outcome => outcome.status === 'rejected');
      if (rejection?.status === 'rejected') throw rejection.reason;
      for (const outcome of outcomes) {
        if (outcome.status !== 'fulfilled') continue;
        sources.push(outcome.value.source);
        records.push(...outcome.value.records);
      }
    }
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    // allSettled preserves requested priority; arrival order cannot change ranks.
    const failures = sources.filter((source) => source.status !== 'ok' && source.status !== 'empty').length;
    const limited = sources.some(source => source.coverage.state === 'limited' || source.status === 'partial' ||
      source.coverage.apiHitCount !== null && source.returnedCount < source.coverage.apiHitCount);
    const unknown = sources.some(source => source.coverage.state === 'unknown');
    return { records, sources, status: failures === 0 ? 'complete' : records.length === 0 && failures === sources.length ? 'failed' : 'partial',
      truncated: limited || fuseLiterature(records).length > request.limit,
      warnings: [...(failures === 0 ? [] : ['部分来源不可用；结果不代表穷尽检索。']),
        ...(limited ? ['当前候选未覆盖全部 API 命中；需要后续分页。'] : []),
        ...(unknown ? ['部分来源未报告总命中数或可核验的分页终点。'] : [])] };
  }

  private async executeSource(request: LiteratureSearchInput, source: typeof literatureSourcePriority[number], deadline: AbortSignal,
    signal: AbortSignal | undefined, audit: LiteratureRequestAudit | undefined): Promise<{source: SourceOutcome; records: RankedLiteratureRecord[]}> {
    const providerSignal = AbortSignal.any([deadline, AbortSignal.timeout(15_000)]);
    const host = researchProviderHosts[source];
    let position = initialPage(source);
    const receipts: ProviderContext['receipts'] = [];
    const visited = new Set<string>();
    const records: RankedLiteratureRecord[] = [];
    const pages: SourceOutcome['pages'] = [];
    let coverage: SourceOutcome['coverage'] = {apiHitCount: null, validatedPages: 0, state: 'unknown', nextPage: position};
    let stopReason: SourceOutcome['stopReason'] = 'page_limit';
    const pageCache = (context: ProviderContext): SourceOutcome['pages'][number]['cache'] => context.cacheHit === null ? {state: 'miss'} :
      {state: 'hit', fetchedAt: context.cacheHit.fetchedAt, responseHash: context.cacheHit.responseHash};
    for (let page = 0; page < request.maxPages; page++) {
      const rankOffset = position.kind === 'page' ? (position.value - 1) * request.limit : position.kind === 'offset' ? position.value : records.length;
      const context: ProviderContext = {signal: providerSignal, receipts, projectId: request.projectId ?? null, host,
        audit: audit === undefined ? undefined : (phase, receipt) => audit(phase, source, receipt),
        cacheHit: null, pendingCache: null, fetchedAt: null, release: null, coverage: null, position, rankOffset, url: null, visited,
        identifiers: null, rawIdentifiers: null, reviews: null};
      visited.add(JSON.stringify(position));
      try {
        providerSignal.throwIfAborted();
        const found = await this.requests.run(context, () => this.searchSource(source, request.query, request.limit, position));
        const valid = found.map(record => researchLiteratureSchema.parse(record));
        for (const record of valid) literatureIdentity(record);
        if (valid.length > request.limit) throw new Error('literature_provider_response_invalid');
        if (context.coverage === null || context.url === null) throw new Error('literature_provider_coverage_missing');
        providerSignal.throwIfAborted();
        if (context.cacheHit === null) this.governor.success(host);
        if (context.pendingCache !== null) this.cache.put(context.pendingCache.key, context.pendingCache.response);
        records.push(...valid.map((record, index) => ({record, rank: context.rankOffset + index + 1,
          identifiers: context.identifiers === null ? [] : context.identifiers[index],
          rawIdentifiers: context.rawIdentifiers === null ? null : context.rawIdentifiers[index],
          review: context.reviews === null ? unknownLiteratureReview() : context.reviews[index]})));
        pages.push({position, rankOffset: context.rankOffset, url: context.url, returnedCount: valid.length, cache: pageCache(context), coverage: context.coverage});
        coverage = {...context.coverage, validatedPages: coverage.validatedPages + 1};
        if (coverage.state === 'reported_end') {
          if (coverage.apiHitCount !== records.length) coverage = {...coverage, state: 'unknown'};
          stopReason = 'reported_end';
          break;
        }
        if (coverage.nextPage === null) { stopReason = 'continuation_unavailable'; break; }
        if (page + 1 === request.maxPages) break;
        if (source === 'semantic_scholar' && coverage.nextPage.kind === 'offset' && coverage.nextPage.value + request.limit > 1000) {
          stopReason = 'provider_limit';
          break;
        }
        position = coverage.nextPage;
      } catch (error) {
        if (error instanceof LiteratureRequestAuditError) throw error;
        this.lifetime.signal.throwIfAborted();
        signal?.throwIfAborted();
        const rateLimited = error instanceof ProviderError && error.status === 429;
        const invalidPayload = error instanceof z.ZodError || error instanceof Error &&
          (error.message === 'literature_provider_response_invalid' || error.message === 'research_doi_invalid' ||
            /^research_(?:arxiv|pmid|europe_pmc)_identifier_invalid$/u.test(error.message));
        if (invalidPayload) this.governor.failure(host, null);
        if (context.url !== null) pages.push({position, rankOffset: context.rankOffset, url: context.url, returnedCount: 0, cache: pageCache(context),
          coverage: {state: 'failed', apiHitCount: null, validatedPages: 0, nextPage: null}});
        return {records, source: {source, status: records.length > 0 ? 'partial' : providerSignal.aborted ? 'timeout' : rateLimited ? 'rate_limited' : 'error',
          returnedCount: records.length, errorCode: providerSignal.aborted ? 'literature_provider_timeout' : rateLimited ? 'literature_provider_rate_limited' :
            error instanceof LiteratureProviderAdmissionError ? error.code : invalidPayload ? 'literature_provider_response_invalid' : 'literature_provider_error',
          retryAfterMs: error instanceof ProviderError || error instanceof LiteratureProviderAdmissionError ? error.retryAfterMs : null,
          requests: receipts, pages, governance: this.governor.observe(host), stopReason: 'failed',
          coverage: {...coverage, state: 'failed', nextPage: position}}};
      } finally { context.release?.(); context.release = null; }
    }
    return {records, source: {source, status: records.length === 0 ? 'empty' : 'ok', returnedCount: records.length,
      errorCode: null, retryAfterMs: null, requests: receipts, pages, coverage, stopReason, governance: this.governor.observe(host)}};
  }

  private async searchSource(
    source: typeof literatureSourcePriority[number],
    query: string,
    limit: number,
    position: LiteraturePagePosition
  ): Promise<ResearchLiterature[]> {
    switch (source) {
      case 'openalex':
        if (position.kind !== 'page') throw new Error('literature_provider_response_invalid');
        return this.searchOpenAlex(query, limit, position.value);
      case 'crossref':
      case 'semantic_scholar':
      case 'arxiv':
        if (position.kind !== 'offset') throw new Error('literature_provider_response_invalid');
        return source === 'crossref' ? this.searchCrossref(query, limit, position.value) :
          source === 'semantic_scholar' ? this.searchSemanticScholar(query, limit, position.value) : this.searchArxiv(query, limit, position.value);
      case 'pubmed':
      case 'europe_pmc':
        if (position.kind !== 'cursor') throw new Error('literature_provider_response_invalid');
        return this.searchEuropePmc(query, limit, source, position.value);
    }
  }

  private async searchOpenAlex(query: string, limit: number, page: number): Promise<ResearchLiterature[]> {
    const payload = openAlexSearchPayload.parse(await this.getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}&page=${page}`));
    const total = payload.meta?.count ?? null;
    this.observeCoverage(total, payload.results.length, total !== null && total > (page - 1) * limit + payload.results.length ? {kind: 'page', value: page + 1} : null);
    const timestamp = this.providerTimestamp();
    this.observeIdentifiers(payload.results.map(item => item.ids == null ? null : literatureRawIdentifiersSchema.parse(item.ids)),
      payload.results.map(item => openAlexIdentifierObservations(item.ids)));
    this.observeReviews(payload.results.map(openAlexReview));
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

  private async searchCrossref(query: string, limit: number, offset: number): Promise<ResearchLiterature[]> {
    const payload = crossrefSearchPayload.parse(await this.getJson(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&offset=${offset}`));
    const total = payload.message['total-results'] ?? null;
    this.observeCoverage(total, payload.message.items.length,
      total !== null && total > offset + payload.message.items.length ? {kind: 'offset', value: offset + payload.message.items.length} : null);
    const timestamp = this.providerTimestamp();
    this.observeReviews(payload.message.items.map(crossrefReview));
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

  private async searchSemanticScholar(query: string, limit: number, offset: number): Promise<ResearchLiterature[]> {
    const payload = semanticScholarSearchPayload.parse(await this.getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&fields=title,authors,abstract,year,citationCount,externalIds,openAccessPdf,url`));
    this.observeCoverage(payload.total ?? null, payload.data.length, payload.next === undefined ? null : {kind: 'offset', value: payload.next});
    const timestamp = this.providerTimestamp();
    this.observeIdentifiers(payload.data.map(item => item.externalIds == null ? null : literatureRawIdentifiersSchema.parse(item.externalIds)),
      payload.data.map(item => semanticScholarIdentifierObservations(item.externalIds)));
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

  private async searchArxiv(query: string, limit: number, offset: number): Promise<ResearchLiterature[]> {
    const xml = await this.getText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}&start=${offset}`);
    if (XMLValidator.validate(xml) !== true) throw new Error('literature_provider_response_invalid');
    const payload = arxivSearchPayload.parse(this.xmlParser.parse(xml));
    const entries = normalizeArray(payload.feed.entry);
    this.observeReviews(entries.map(entry => arxivReview(entry.id)));
    this.observeCoverage(payload.feed.totalResults, entries.length,
      payload.feed.totalResults > offset + entries.length ? {kind: 'offset', value: offset + entries.length} : null);
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

  private async searchEuropePmc(query: string, limit: number, source: 'pubmed' | 'europe_pmc', cursor: string): Promise<ResearchLiterature[]> {
    const medQuery = source === 'pubmed' ? `(${query}) AND SRC:MED` : query;
    const payload = europePmcSearchPayload.parse(await this.getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(medQuery)}&format=json&pageSize=${limit}&cursorMark=${encodeURIComponent(cursor)}`));
    this.observeCoverage(payload.hitCount ?? null, payload.resultList.result.length,
      payload.nextCursorMark === undefined ? null : {kind: 'cursor', value: payload.nextCursorMark});
    const timestamp = this.providerTimestamp();
    return payload.resultList.result.map((item) => {
      if (source === 'pubmed' && item.source !== 'MED') throw new Error('literature_provider_response_invalid');
      return {
        id: `${source}:${item.source}:${item.id}`,
        source,
        externalId: source === 'pubmed' ? item.id : `${item.source}:${item.id}`,
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
      };
    });
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
    const context = this.requests.getStore();
    if (context === undefined) throw new Error('literature_provider_context_missing');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host !== context.host || !url.startsWith(`https://${context.host}/`)) {
      throw new Error('literature_provider_url_invalid');
    }
    context.url = url;
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

  private observeIdentifiers(raw: Array<LiteratureRawIdentifiers | null>, identifiers: LiteratureIdentifierObservation[][]): void {
    const context = this.requests.getStore();
    if (context === undefined) throw new Error('literature_provider_context_missing');
    context.rawIdentifiers = raw;
    context.identifiers = identifiers;
  }

  private observeReviews(reviews: LiteratureReview[]): void {
    const context = this.requests.getStore();
    if (context === undefined) throw new Error('literature_provider_context_missing');
    context.reviews = reviews.map(review => literatureReviewSchema.parse(review));
  }

  private observeCoverage(apiHitCount: number | null, returnedCount: number,
    nextPage: LiteratureSearchResult['sources'][number]['coverage']['nextPage']): void {
    const context = this.requests.getStore();
    if (context === undefined) throw new Error('literature_provider_context_missing');
    if (apiHitCount !== null && (apiHitCount < returnedCount || apiHitCount > context.rankOffset && returnedCount === 0)) {
      throw new Error('literature_provider_response_invalid');
    }
    if (nextPage !== null && (context.visited.has(JSON.stringify(nextPage)) ||
      nextPage.kind === 'offset' && context.position.kind === 'offset' &&
        (nextPage.value <= context.position.value || nextPage.value < context.rankOffset + returnedCount))) {
      throw new Error('literature_provider_response_invalid');
    }
    context.coverage = {apiHitCount, validatedPages: 1, nextPage,
      state: nextPage !== null || apiHitCount !== null && apiHitCount > context.rankOffset + returnedCount ? 'limited' :
        apiHitCount === null ? 'unknown' : 'reported_end'};
  }

  private async readAttempt(url: string, accept: string, context: ProviderContext): Promise<CachedLiteratureResponse> {
    const receipt: ProviderContext['receipts'][number] = {attempt: context.receipts.length + 1, method: 'GET', url,
      startedAt: new Date().toISOString(), endedAt: null, status: null, retryAfterMs: null, responseHash: null, errorCode: null};
    context.receipts.push(receipt);
    context.audit?.('started', receipt);
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
      receipt.errorCode = signal.aborted ? this.lifetime.signal.aborted ? 'literature_provider_shutdown' :
        signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'literature_provider_timeout' : 'literature_provider_cancelled' :
        error instanceof ProviderError ? `literature_provider_http_${error.status}` : 'literature_provider_transport_error';
      throw error;
    } finally {
      receipt.endedAt = new Date().toISOString();
      context.audit?.('finished', receipt);
    }
  }
}

function initialPage(source: typeof literatureSourcePriority[number]): LiteraturePagePosition {
  return source === 'openalex' ? {kind: 'page', value: 1} :
    source === 'pubmed' || source === 'europe_pmc' ? {kind: 'cursor', value: '*'} : {kind: 'offset', value: 0};
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
