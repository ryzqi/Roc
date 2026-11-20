import {isIP} from 'node:net';
import {normalizeResearchArxiv, normalizeResearchDoi, normalizeResearchPmid} from './literature-identity';
import {researchProviderHosts, type LiteratureProviderGovernor} from './literature-provider-governor';
import {readPublicOpenReviewSearch} from './openreview-adapter';

export type PdfSourceCandidate = {
  url: string;
  provider: 'arxiv' | 'openalex' | 'semantic_scholar' | 'europe_pmc' | 'openreview' | 'acl' | 'cvf' | 'unpaywall';
  version: string | null;
  license: string | null;
  doi: string | null;
  arxivId: string | null;
  openAlexId: string | null;
};

export type PdfSourceInput = {
  doi?: string | null;
  arxivId?: string | null;
  openAlexId?: string | null;
  semanticScholarId?: string | null;
  pmcid?: string | null;
  pmid?: string | null;
  openReviewId?: string | null;
  aclId?: string | null;
  cvfId?: string | null;
};

/** Balanced preserves discovery order (including arXiv first). Preprint prefers preprints,
 * then accepted/published copies; it does not infer chronology from missing dates.
 * An explicitly requested arXiv revision is never replaced with an unpinned URL. */
export type PdfVersionPreference = 'balanced' | 'preprint' | 'published';

export type PdfResolutionEvidence = {
  preference: PdfVersionPreference;
  candidates: ReadonlyArray<{
    candidate: PdfSourceCandidate;
    rank: number;
    discoveryRank: number;
    priority: number;
    reason: 'provider-order' | 'arxiv-latest-endpoint' | 'arxiv-explicit-version' |
      'published-version' | 'accepted-version' | 'submitted-version' | 'unknown-version';
  }>;
};

export type PdfResolverDependencies = {
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
  timeoutMs?: number;
  governor?: LiteratureProviderGovernor;
  onProviderError?: (provider: PdfSourceCandidate['provider'], error: unknown) => void;
  versionPreference?: PdfVersionPreference;
  onResolution?: (evidence: PdfResolutionEvidence) => void;
  unpaywallEmail?: string | null;
  onlyDoiFallback?: boolean;
};

type OpenAlexLocation = {
  pdf_url?: unknown;
  is_oa?: unknown;
  version?: unknown;
  license?: unknown;
};

const defaultResponseLimit = 1024 * 1024;
const defaultTimeoutMs = 10_000;
const openAlexIdPattern = /^W\d{1,12}$/u;
const semanticScholarIdPattern = /^(?:[\da-f]{40}|CorpusId:\d+)$/iu;

function optionalIdentifier(value: string | null | undefined, normalize: (value: string) => string): string | null {
  if (value === null || value === undefined) return null;
  if (!value.trim()) throw new Error('research_pdf_identifier_invalid');
  return normalize(value);
}

function normalizeOpenAlexId(value: string): string {
  let id = value.trim();
  if (/^https?:\/\//iu.test(id)) {
    let url: URL;
    try { url = new URL(id); } catch (cause) { throw new Error('research_openalex_identifier_invalid', {cause}); }
    if (url.protocol !== 'https:' || !['openalex.org', 'www.openalex.org'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port || url.search || url.hash || !/^\/W\d{1,12}$/u.test(url.pathname)) {
      throw new Error('research_openalex_identifier_invalid');
    }
    id = url.pathname.slice(1);
  }
  if (!openAlexIdPattern.test(id)) throw new Error('research_openalex_identifier_invalid');
  return id.toUpperCase();
}

function normalizeSemanticScholarId(value: string): string {
  const id = value.trim();
  if (!semanticScholarIdPattern.test(id)) throw new Error('research_semantic_scholar_identifier_invalid');
  return id;
}

function normalizePmcid(value: string): string {
  const id = value.trim().toUpperCase().replace(/^HTTPS?:\/\/(?:WWW\.)?NCBI\.NLM\.NIH\.GOV\/PMC\/ARTICLES\//u, '');
  if (!/^PMC[1-9]\d{0,11}$/u.test(id)) throw new Error('research_pmcid_invalid');
  return id;
}

/** Only call for a PDF field of an identity-validated provider record, never a landing-page field. */
function pdfDesignatedUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash ||
    url.href.length > 4096) return null;
  const hostname = url.hostname.toLowerCase();
  // Provider links must name a public host. DNS answers and every redirect remain
  // independently checked by the downloader; a provider declaration cannot bypass them.
  if (!hostname.includes('.') || hostname.endsWith('.') || hostname.startsWith('[') || isIP(hostname) !== 0 ||
    /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|onion)$/u.test(hostname)) return null;
  return url.href;
}

function providerDoi(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return normalizeResearchDoi(value); } catch { return null; }
}

function providerOpenAlexId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return normalizeOpenAlexId(value); } catch { return null; }
}

function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 24 * 60 * 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - now, 24 * 60 * 60_000)) : null;
}

async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw new Error('research_pdf_provider_body_missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('research_pdf_provider_response_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))));
}

function validateOpenAlexResponse(payload: unknown, doi: string | null, requestedId: string | null): {
  doi: string | null; openAlexId: string | null; locations: OpenAlexLocation[];
} | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const item = payload as Record<string, unknown>;
  const openAlexId = providerOpenAlexId(item.id);
  if (requestedId !== null && openAlexId !== requestedId) return null;
  const ids = typeof item.ids === 'object' && item.ids !== null ? item.ids as Record<string, unknown> : {};
  const resolvedDoi = providerDoi(item.doi) ?? providerDoi(ids.doi);
  if (doi !== null && resolvedDoi !== doi) return null;
  const isLocation = (entry: unknown): entry is OpenAlexLocation =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry);
  // best_oa_location itself declares OA; tolerate older records without is_oa.
  const best = isLocation(item.best_oa_location) &&
    (item.best_oa_location.is_oa === undefined || item.best_oa_location.is_oa === true) ? [item.best_oa_location] : [];
  const primary = isLocation(item.primary_location) && item.primary_location.is_oa === true ? [item.primary_location] : [];
  const locations = Array.isArray(item.locations) ? item.locations.filter((entry): entry is OpenAlexLocation =>
    isLocation(entry) && entry.is_oa === true) : [];
  return {doi: resolvedDoi, openAlexId, locations: [...best, ...primary, ...locations]};
}

function openAlexCandidates(record: NonNullable<ReturnType<typeof validateOpenAlexResponse>>, input: {doi: string | null; arxivId: string | null}): PdfSourceCandidate[] {
  const candidates: PdfSourceCandidate[] = [];
  for (const location of record.locations) {
    const url = pdfDesignatedUrl(location.pdf_url);
    if (url === null) continue;
    candidates.push({url, provider: 'openalex', version: typeof location.version === 'string' ? location.version : null,
      license: typeof location.license === 'string' ? location.license : null, doi: record.doi ?? input.doi,
      arxivId: input.arxivId, openAlexId: record.openAlexId});
  }
  return candidates;
}

function semanticScholarCandidate(payload: unknown, input: {doi: string | null; arxivId: string | null; semanticScholarId: string | null; openAlexId: string | null}): PdfSourceCandidate | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const item = payload as Record<string, unknown>;
  if (input.semanticScholarId !== null && item.paperId !== input.semanticScholarId) return null;
  const external = typeof item.externalIds === 'object' && item.externalIds !== null ? item.externalIds as Record<string, unknown> : {};
  const doi = providerDoi(external.DOI);
  let arxivId: string | null = null;
  if (typeof external.ArXiv === 'string') {
    try { arxivId = normalizeResearchArxiv(external.ArXiv).id; } catch { return null; }
  }
  if (input.doi !== null && doi !== input.doi) return null;
  if (input.arxivId !== null && arxivId !== input.arxivId) return null;
  const oa = typeof item.openAccessPdf === 'object' && item.openAccessPdf !== null ? item.openAccessPdf as Record<string, unknown> : {};
  const url = pdfDesignatedUrl(oa.url);
  if (url === null) return null;
  return {url, provider: 'semantic_scholar', version: null, license: typeof oa.license === 'string' ? oa.license : null,
    doi: doi ?? input.doi, arxivId: arxivId ?? input.arxivId, openAlexId: input.openAlexId};
}

function europePmcCandidates(payload: unknown, input: {doi: string | null; arxivId: string | null; pmcid: string | null; pmid: string | null; openAlexId: string | null}): PdfSourceCandidate[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  const resultList = (payload as Record<string, unknown>).resultList;
  if (typeof resultList !== 'object' || resultList === null || Array.isArray(resultList)) return [];
  const results = (resultList as Record<string, unknown>).result;
  if (!Array.isArray(results)) return [];
  const candidates: PdfSourceCandidate[] = [];
  for (const raw of results) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const result = raw as Record<string, unknown>;
    const resultDoi = providerDoi(result.doi);
    const resultPmid = typeof result.pmid === 'string' ? result.pmid : null;
    const resultPmcid = typeof result.pmcid === 'string' ? result.pmcid.toUpperCase() : null;
    if ((input.doi !== null && resultDoi !== input.doi) || (input.pmid !== null && resultPmid !== input.pmid) ||
      (input.pmcid !== null && resultPmcid !== input.pmcid)) continue;
    if (result.isOpenAccess !== 'Y') continue;
    const recordPmcid = resultPmcid ?? input.pmcid;
    if (recordPmcid !== null && /^PMC[1-9]\d{0,11}$/u.test(recordPmcid)) {
      candidates.push({url: `https://pmc.ncbi.nlm.nih.gov/articles/${recordPmcid}/pdf/`, provider: 'europe_pmc', version: 'publishedVersion',
        license: typeof result.license === 'string' ? result.license : null, doi: resultDoi ?? input.doi,
        arxivId: input.arxivId, openAlexId: input.openAlexId});
    }
    const fullText = typeof result.fullTextUrlList === 'object' && result.fullTextUrlList !== null ? result.fullTextUrlList as Record<string, unknown> : {};
    const entries = typeof fullText.fullTextUrl === 'object' && fullText.fullTextUrl !== null ?
      Array.isArray(fullText.fullTextUrl) ? fullText.fullTextUrl : [fullText.fullTextUrl] : [];
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const fullTextUrl = entry as Record<string, unknown>;
      if (typeof fullTextUrl.documentStyle !== 'string' || fullTextUrl.documentStyle.toLowerCase() !== 'pdf') continue;
      const url = pdfDesignatedUrl(fullTextUrl.url);
      if (url === null) continue;
      candidates.push({url, provider: 'europe_pmc', version: null, license: null, doi: resultDoi ?? input.doi,
        arxivId: input.arxivId, openAlexId: input.openAlexId});
    }
  }
  return candidates;
}

function candidatePreference(candidate: PdfSourceCandidate, preference: PdfVersionPreference): {
  priority: number; reason: PdfResolutionEvidence['candidates'][number]['reason'];
} {
  if (preference === 'balanced') return {priority: 0, reason: 'provider-order'};
  if (candidate.provider === 'arxiv') return {priority: preference === 'preprint' ? 0 : 2,
    reason: candidate.version === null ? 'arxiv-latest-endpoint' : 'arxiv-explicit-version'};
  const version = candidate.version?.toLowerCase();
  if (version === 'publishedversion' || version === 'published') {
    return {priority: preference === 'published' ? 0 : 3, reason: 'published-version'};
  }
  if (version === 'acceptedversion' || version === 'accepted') {
    return {priority: preference === 'published' ? 1 : 2, reason: 'accepted-version'};
  }
  if (version === 'submittedversion' || version === 'submitted' || version === 'preprint' || /^v[1-9]\d*$/u.test(version ?? '')) {
    return {priority: preference === 'preprint' ? 1 : 2, reason: 'submitted-version'};
  }
  return {priority: preference === 'published' ? 3 : 4, reason: 'unknown-version'};
}

/** Resolve only provider-designated PDF locations. Provider failures are isolated so one API outage does not hide other open copies. */
export async function resolvePdfSources(input: PdfSourceInput, signal: AbortSignal, deps: PdfResolverDependencies = {}): Promise<PdfSourceCandidate[]> {
  const doi = optionalIdentifier(input.doi, normalizeResearchDoi);
  const arxivValue = optionalIdentifier(input.arxivId, value => normalizeResearchArxiv(value).id);
  const openAlexId = optionalIdentifier(input.openAlexId, normalizeOpenAlexId);
  const semanticScholarId = optionalIdentifier(input.semanticScholarId, normalizeSemanticScholarId);
  const pmcid = optionalIdentifier(input.pmcid, normalizePmcid);
  const pmid = optionalIdentifier(input.pmid, normalizeResearchPmid);
  const checked = (value: string | null | undefined, pattern: RegExp): string | null => optionalIdentifier(value, id => {
    if (!pattern.test(id)) throw new Error('research_pdf_identifier_invalid');
    return id;
  });
  const openReviewId = checked(input.openReviewId, /^[A-Za-z0-9_-]{1,128}$/u);
  const aclId = checked(input.aclId, /^(?:[A-Z]\d{2}-\d{4}|20\d{2}\.[a-z][a-z0-9-]*-\w+\.\d+)$/u);
  const cvfId = checked(input.cvfId, /^content\/(?:CVPR|ICCV|WACV)20\d{2}\/html\/[A-Za-z0-9_.-]+\.html$/u);
  const arxivId = arxivValue;
  if ([doi, arxivId, openAlexId, semanticScholarId, pmcid, pmid, openReviewId, aclId, cvfId].every(value => value === null)) {
    throw new Error('research_pdf_identifier_required');
  }
  const effectiveDoi = doi ?? (arxivId === null ? null : `10.48550/arxiv.${arxivId.toLowerCase()}`);
  const fetcher = deps.fetch ?? globalThis.fetch;
  const maxResponseBytes = deps.maxResponseBytes ?? defaultResponseLimit;
  const timeoutMs = deps.timeoutMs ?? defaultTimeoutMs;
  const preference = deps.versionPreference ?? 'balanced';
  if (!['balanced', 'preprint', 'published'].includes(preference)) throw new Error('research_pdf_version_preference_invalid');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('research_pdf_resolver_limits_invalid');
  }

  const candidates: PdfSourceCandidate[] = [];
  if (arxivId !== null && !deps.onlyDoiFallback) {
    const version = normalizeResearchArxiv(input.arxivId!).version;
    const path = arxivId.split('/').map(encodeURIComponent).join('/');
    candidates.push({url: `https://arxiv.org/pdf/${path}${version === null ? '' : `v${version}`}`, provider: 'arxiv',
      version: version === null ? null : `v${version}`, license: null, doi: effectiveDoi, arxivId, openAlexId});
  }
  if (!deps.onlyDoiFallback) {
    if (aclId !== null) candidates.push({url: `https://aclanthology.org/${aclId}.pdf`, provider: 'acl',
      version: 'publishedVersion', license: null, doi: effectiveDoi, arxivId, openAlexId});
    if (cvfId !== null) candidates.push({url: `https://openaccess.thecvf.com/${cvfId.replace('/html/', '/papers/').replace(/\.html$/u, '.pdf')}`,
      provider: 'cvf', version: 'acceptedVersion', license: null, doi: effectiveDoi, arxivId, openAlexId});
  }

  const getJson = async (url: URL): Promise<unknown> => {
    signal.throwIfAborted();
    const host = url.hostname;
    let release: (() => void) | undefined;
    let failed = false;
    let retryAfter: number | null = null;
    try {
      release = await deps.governor?.acquire(host, signal);
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = AbortSignal.any([signal, timeout]);
      const response = await fetcher(url, {method: 'GET', headers: {accept: 'application/json', 'user-agent': 'Roc-PdfResolver/1.0'},
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: requestSignal});
      deps.governor?.responseLimits(host, response.headers);
      if (!response.ok) {
        retryAfter = retryAfterMs(response.headers.get('retry-after'));
        await response.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error(`research_pdf_provider_http_${response.status}`), {status: response.status, retryAfterMs: retryAfter});
      }
      const payload = await readJson(response, maxResponseBytes, requestSignal);
      return payload;
    } catch (error) {
      failed = true;
      if (error instanceof Error && 'status' in error) deps.governor?.failure(host, retryAfter);
      else if (!signal.aborted && release !== undefined) deps.governor?.failure(host, null);
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error('research_pdf_provider_timeout', {cause: error});
      throw error;
    } finally {
      if (!failed) deps.governor?.success(host);
      release?.();
    }
  };

  const openAlexRequestedId = openAlexId;
  if (!deps.onlyDoiFallback && (effectiveDoi !== null || openAlexRequestedId !== null)) {
    const url = new URL(`https://${researchProviderHosts.openalex}/works/${encodeURIComponent(
      openAlexRequestedId === null ? `https://doi.org/${effectiveDoi}` : openAlexRequestedId)}`);
    try {
      const payload = await getJson(url);
      const record = validateOpenAlexResponse(payload, effectiveDoi, openAlexRequestedId);
      if (record !== null) candidates.push(...openAlexCandidates(record, {doi: effectiveDoi, arxivId}));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      deps.onProviderError?.('openalex', error);
    }
  }

  if (!deps.onlyDoiFallback && (semanticScholarId !== null || effectiveDoi !== null || arxivId !== null)) {
    const identifier = semanticScholarId ?? (effectiveDoi !== null ? `DOI:${effectiveDoi}` : `ARXIV:${arxivId}`);
    const url = new URL(`https://${researchProviderHosts.semantic_scholar}/graph/v1/paper/${encodeURIComponent(identifier)}`);
    url.searchParams.set('fields', 'paperId,externalIds,openAccessPdf');
    try {
      const payload = await getJson(url);
      const candidate = semanticScholarCandidate(payload, {doi: effectiveDoi, arxivId, semanticScholarId, openAlexId});
      if (candidate !== null) candidates.push(candidate);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      deps.onProviderError?.('semantic_scholar', error);
    }
  }

  if (!deps.onlyDoiFallback && (pmcid !== null || pmid !== null || effectiveDoi !== null)) {
    const query = pmcid !== null ? `EXT_ID:${pmcid}` : pmid !== null ? `EXT_ID:${pmid}` : `DOI:${effectiveDoi}`;
    const url = new URL(`https://${researchProviderHosts.europe_pmc}/europepmc/webservices/rest/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('resultType', 'core');
    url.searchParams.set('pageSize', '1');
    try {
      const payload = await getJson(url);
      candidates.push(...europePmcCandidates(payload, {doi: effectiveDoi, arxivId, pmcid, pmid, openAlexId}));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      deps.onProviderError?.('europe_pmc', error);
    }
  }

  if (openReviewId !== null && !deps.onlyDoiFallback) {
    try {
      const url = new URL(`https://${researchProviderHosts.openreview}/notes`);
      url.searchParams.set('id', openReviewId);
      const page = readPublicOpenReviewSearch(await getJson(url), 1);
      const note = page.notes[0];
      if (note?.id === openReviewId) {
        const field = note.content.pdf;
        const value = field?.readers === undefined || field.readers.includes('everyone') ? field?.value : null;
        const pdf = typeof value === 'string' ? pdfDesignatedUrl(new URL(value, 'https://openreview.net').href) : null;
        if (pdf !== null) candidates.push({url: pdf, provider: 'openreview', version: null, license: note.license ?? null,
          doi: effectiveDoi, arxivId, openAlexId});
      }
    } catch (error) {
      signal.throwIfAborted();
      deps.onProviderError?.('openreview', error);
    }
  }
  // Optional DOI lookup is a fallback, not a search source or an independent OA vote.
  if ((candidates.length === 0 || deps.onlyDoiFallback) && effectiveDoi !== null && deps.unpaywallEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(deps.unpaywallEmail)) throw new Error('research_unpaywall_email_invalid');
    try {
      const url = new URL(`https://${researchProviderHosts.unpaywall}/v2/${encodeURIComponent(effectiveDoi)}`);
      url.searchParams.set('email', deps.unpaywallEmail);
      const payload = await getJson(url);
      if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
        const item = payload as Record<string, unknown>;
        if (providerDoi(item.doi) === effectiveDoi && item.is_oa === true) {
          const locations = [item.best_oa_location, ...(Array.isArray(item.oa_locations) ? item.oa_locations : [])];
          for (const location of locations) {
            if (typeof location !== 'object' || location === null || Array.isArray(location)) continue;
            const entry = location as Record<string, unknown>;
            const pdf = pdfDesignatedUrl(entry.url_for_pdf);
            if (pdf !== null) candidates.push({url: pdf, provider: 'unpaywall',
              version: typeof entry.version === 'string' ? entry.version : null, license: typeof entry.license === 'string' ? entry.license : null,
              doi: effectiveDoi, arxivId, openAlexId});
          }
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      // Never propagate URL-bearing transport errors containing the user's contact email.
      deps.onProviderError?.('unpaywall', Object.assign(new Error('research_unpaywall_unavailable'), {
        retryAfterMs: error instanceof Error && 'retryAfterMs' in error ? error.retryAfterMs : null
      }));
    }
  }

  const seen = new Set<string>();
  const ordered = candidates.map((candidate, index) => ({candidate, discoveryRank: index + 1, ...candidatePreference(candidate, preference)}))
    .sort((a, b) => a.priority - b.priority || a.discoveryRank - b.discoveryRank)
    .filter(({candidate}) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    });
  deps.onResolution?.({preference, candidates: ordered.map((entry, index) => ({
    ...entry, candidate: {...entry.candidate}, rank: index + 1
  }))});
  return ordered.map(({candidate}) => candidate);
}
