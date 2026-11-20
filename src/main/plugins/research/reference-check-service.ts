import {createHash} from 'node:crypto';
import {z} from 'zod';
import {referenceCheckRequestSchema, type ReferenceMetadata, type ReferenceCheckReport} from '../../../shared/schemas/research-reference-check';
import type {ResearchRepository} from './repository';
import type {LiteratureSearchService} from './literature-service';
import {crossrefSearchPayload, openAlexSearchPayload} from './literature-provider-schemas';
import {crossrefReview, openAlexReview, unknownLiteratureReview} from './literature-provider-review';
import {normalizeResearchDoi} from './literature-identity';

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Similarity is a review hint, never proof of identity (including for CJK titles). */
export function compareReference(input: ReferenceMetadata, remote: ReferenceMetadata) {
  const title = normalize(input.title), other = normalize(remote.title);
  const grams = (value: string): Set<string> => new Set(Array.from(value).flatMap((char, i, chars) => i + 1 < chars.length ? [char + chars[i + 1]] : []));
  const a = grams(title), b = grams(other), union = new Set([...a, ...b]);
  const similarity = title === '' || other === '' ? null : title === other ? 1 :
    union.size === 0 ? 0 : [...a].filter(part => b.has(part)).length / union.size;
  const fields = {
    title: title === '' || other === '' ? 'unknown' : title === other ? 'match' : 'different',
    authors: input.authors.length === 0 || remote.authors.length === 0 ? 'unknown' :
      JSON.stringify(input.authors.map(normalize)) === JSON.stringify(remote.authors.map(normalize)) ? 'match' : 'different',
    year: input.year === null || remote.year === null ? 'unknown' : input.year === remote.year ? 'match' : 'different'
  } as const;
  const identity = input.doi === null || remote.doi === null ? 'unresolved' :
    normalizeResearchDoi(input.doi) === normalizeResearchDoi(remote.doi) ? 'doi_match' : 'doi_mismatch';
  const verdict = identity === 'doi_mismatch' || Object.values(fields).includes('different') ? 'needs_review' :
    identity === 'doi_match' && Object.values(fields).every(value => value === 'match') ? 'consistent' : 'unknown';
  return {identity, fields, titleSimilarity: similarity, verdict} as const;
}

export class ReferenceCheckService {
  constructor(private readonly repository: Pick<ResearchRepository, 'getProject' | 'library'>,
    private readonly providers: Pick<LiteratureSearchService, 'readProviderJson'>) {}

  private async candidates(projectId: string, source: 'crossref' | 'openalex', input: ReferenceMetadata, signal?: AbortSignal): Promise<ReferenceCheckReport['results'][number]['observations']> {
    const url = source === 'crossref' ? `https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent([input.title, input.authors[0]].filter(Boolean).join(' ').slice(0, 1500))}` :
      `https://api.openalex.org/works?per-page=3&search=${encodeURIComponent(input.title.slice(0, 1500))}`;
    const response = await this.providers.readProviderJson({source, url, projectId, timeoutMs: 15000}, payload => {
      if (source === 'crossref') return crossrefSearchPayload.parse(payload).message.items.slice(0, 3).map(value => ({
        metadata: {doi: normalizeResearchDoi(value.DOI), title: value.title[0], authors: (value.author ?? []).map(author => [author.given, author.family].filter(Boolean).join(' ')).filter(Boolean), year: value.published?.['date-parts']?.[0]?.[0] ?? null}, review: crossrefReview(value)
      }));
      return openAlexSearchPayload.parse(payload).results.slice(0, 3).map(value => ({metadata: {
        doi: value.doi == null ? null : normalizeResearchDoi(value.doi), title: value.title,
        authors: (value.authorships ?? []).flatMap(author => author.author?.display_name ? [author.author.display_name] : []), year: value.publication_year ?? null
      }, review: openAlexReview(value)}));
    }, signal);
    const receipt = {source, lookup: 'title_candidate' as const, url, fetchedAt: response.fetchedAt, responseHash: response.responseHash, cache: response.cache};
    if (response.status === 'error' || response.value.length === 0) return [{...receipt, metadata: null, review: unknownLiteratureReview(),
      status: response.status === 'error' ? 'error' : 'unknown', errorCode: response.status === 'error' ? response.errorCode : 'no_candidates',
      identity: 'unresolved', fields: {title: 'unknown', authors: 'unknown', year: 'unknown'}, titleSimilarity: null, verdict: 'unknown'}];
    return response.value.map(value => ({...receipt, ...value, ...compareReference(input, value.metadata),
      identity: 'unresolved', verdict: 'needs_review', status: 'checked', errorCode: null}));
  }

  async check(input: unknown, signal?: AbortSignal): Promise<ReferenceCheckReport> {
    const request = referenceCheckRequestSchema.parse(input);
    this.repository.getProject(request.projectId);
    // Validate the whole selection before sending any metadata to providers.
    const items = request.ids.map(id => {
      const item = this.repository.library.get(id);
      if (!item.projectIds.includes(request.projectId)) throw new Error('research_library_project_mismatch');
      return item;
    });
    const results: ReferenceCheckReport['results'] = [];
    for (const item of items) {
      signal?.throwIfAborted();
      const bibliography = item.bibliography;
      const metadata: ReferenceMetadata = {doi: bibliography.doi ?? item.metadata.doi,
        title: bibliography.title, authors: bibliography.authors, year: bibliography.publishedYear};
      const observations: ReferenceCheckReport['results'][number]['observations'] = [];
      for (const source of ['crossref', 'openalex'] as const) {
        const base = {source, metadata: null, review: unknownLiteratureReview(), identity: 'unresolved' as const,
          fields: {title: 'unknown' as const, authors: 'unknown' as const, year: 'unknown' as const}, titleSimilarity: null, verdict: 'unknown' as const};
        if (metadata.doi === null && request.titleSearch === true && metadata.title.trim()) {
          observations.push(...await this.candidates(request.projectId, source, metadata, signal)); continue;
        }
        if (metadata.doi === null) {
          observations.push({...base, url: null, status: 'unknown', errorCode: 'doi_missing', fetchedAt: null, responseHash: null, cache: null});
          continue;
        }
        const doi = normalizeResearchDoi(metadata.doi);
        const url = source === 'crossref' ? `https://api.crossref.org/works/${encodeURIComponent(doi)}` :
          `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
        const response = await this.providers.readProviderJson({source, url, projectId: request.projectId, timeoutMs: 15000}, payload => {
          if (source === 'crossref') {
            const value = z.looseObject({message: crossrefSearchPayload.shape.message.shape.items.element}).parse(payload).message;
            return {metadata: {doi: normalizeResearchDoi(value.DOI), title: value.title[0],
              authors: (value.author ?? []).map(author => [author.given, author.family].filter(Boolean).join(' ')).filter(Boolean),
              year: value.published?.['date-parts']?.[0]?.[0] ?? null}, review: crossrefReview(value)};
          }
          const value = openAlexSearchPayload.shape.results.element.parse(payload);
          return {metadata: {doi: value.doi == null ? null : normalizeResearchDoi(value.doi), title: value.title,
            authors: (value.authorships ?? []).flatMap(author => author.author?.display_name ? [author.author.display_name] : []),
            year: value.publication_year ?? null}, review: openAlexReview(value)};
        }, signal);
        const receipt = {url, fetchedAt: response.fetchedAt, responseHash: response.responseHash, cache: response.cache};
        observations.push(response.status === 'error' ? {...base, ...receipt, status: 'error', errorCode: response.errorCode} :
          {...base, ...receipt, status: 'checked', errorCode: null, ...response.value, ...compareReference(metadata, response.value.metadata)});
      }
      results.push({id: item.id, revision: item.revision, citationKey: bibliography.citationKey,
        inputHash: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'), input: metadata, observations});
    }
    signal?.throwIfAborted();
    return {projectId: request.projectId, checkedAt: new Date().toISOString(), algorithm: 'roc-reference-check-v1', results};
  }
}
