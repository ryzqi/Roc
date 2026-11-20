import type {LiteratureReview} from '../../../shared/schemas/literature-review';
import {normalizeResearchArxiv} from './literature-identity';

export function unknownLiteratureReview(): LiteratureReview {
  return {publicationType: null, copies: [], retraction: {status: 'unknown', field: null}, updates: []};
}

export function openAlexReview(item: {type?: string | null; is_retracted?: boolean | null;
  primary_location?: {landing_page_url?: string | null; version?: string | null; license?: string | null} | null}): LiteratureReview {
  const location = item.primary_location;
  return {publicationType: item.type ?? null,
    copies: location == null ? [] : [{field: 'primary_location', locationUrl: location.landing_page_url ?? null,
      version: location.version ?? null, license: location.license ?? null}],
    retraction: item.is_retracted == null ? {status: 'unknown', field: null} :
      {status: item.is_retracted ? 'retracted' : 'not_reported', field: 'is_retracted'}, updates: []};
}

export function crossrefReview(item: {type?: string | null;
  license?: Array<{URL: string; 'content-version': string}>;
  'update-to'?: Array<{type: string; DOI: string; label: string; source: string}>}): LiteratureReview {
  return {...unknownLiteratureReview(), publicationType: item.type ?? null,
    copies: (item.license ?? []).map((license, index) => ({field: `license[${index}]`,
      locationUrl: null, version: license['content-version'], license: license.URL})),
    updates: (item['update-to'] ?? []).map(update => ({type: update.type, doi: update.DOI, label: update.label, source: update.source}))};
}

export function arxivReview(externalId: string): LiteratureReview {
  const {version} = normalizeResearchArxiv(externalId);
  return {...unknownLiteratureReview(), copies: [{field: 'entry.id', locationUrl: externalId,
    version: version === null ? null : `v${version}`, license: null}]};
}
