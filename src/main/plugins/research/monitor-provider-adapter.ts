import {z} from 'zod';
import {monitorProviderMaterialSchema, type MonitorMaterial} from '../../../shared/schemas/research-monitors';
import {normalizeResearchDoi} from './literature-identity';
import {resourceContentHash} from './resource-repository';
import type {LiteratureSearchResult} from '../../../shared/schemas/literature-import';

export function searchMonitorMaterial(search: LiteratureSearchResult): MonitorMaterial {
  const events: MonitorMaterial['events'] = [];
  for (const candidate of search.candidates) {
    const selected = candidate.origins.find(origin => origin.record.id === candidate.record.id) ?? candidate.origins[0]!;
    events.push({identity: candidate.identity, kind: 'new_paper', title: candidate.record.title,
      subjectDoi: candidate.record.doi, noticeDoi: null, field: 'candidate.identity',
      providerType: null, sourceHash: selected.metadataHash});
    for (const origin of candidate.origins) {
      if (origin.review.retraction.status === 'retracted') events.push({
        identity: candidate.identity, kind: 'retraction', title: origin.record.title, subjectDoi: origin.record.doi,
        noticeDoi: null, field: origin.review.retraction.field!, providerType: 'is_retracted', sourceHash: origin.metadataHash
      });
      for (const update of origin.review.updates) {
        const target = normalizeResearchDoi(update.doi), notice = origin.record.doi;
        events.push({identity: update.type === 'retraction' ? `doi:${target}` : `${candidate.identity}->doi:${target}:${update.type}`,
          kind: update.type === 'retraction' ? 'retraction' : update.type === 'correction' ? 'correction' : 'other_update',
          title: origin.record.title, subjectDoi: target, noticeDoi: notice, field: 'update-to',
          providerType: update.type, sourceHash: origin.metadataHash});
      }
    }
  }
  const unique = [...new Map(events.map(event => [JSON.stringify([event.identity, event.kind]), event])).values()];
  return monitorProviderMaterialSchema.parse({records: [], providerTotal: null, events: unique, nextOffset: 0,
    coverage: search.truncated ? 'limited' : 'reported_end'});
}

export function monitorUpdateEndpoint(source: 'openalex' | 'crossref', doi: string, offset: number): string {
  const normalized = normalizeResearchDoi(doi);
  if (source === 'openalex') return `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalized)}?select=id,doi,is_retracted,title`;
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('filter', `updates:${normalized}`);
  url.searchParams.set('rows', '100');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('sort', 'indexed');
  url.searchParams.set('order', 'asc');
  return url.href;
}

export function readMonitorUpdates(source: 'openalex' | 'crossref', doi: string, offset: number, payload: unknown): MonitorMaterial {
  const normalized = normalizeResearchDoi(doi);
  if (source === 'openalex') {
    const value = z.object({id: z.string().regex(/^https:\/\/openalex\.org\/W[1-9]\d*$/u),
      doi: z.string(), title: z.string().min(1).max(4000), is_retracted: z.boolean()}).parse(payload);
    if (normalizeResearchDoi(value.doi) !== normalized) throw new Error('scholarly_provider_identity_mismatch');
    return monitorProviderMaterialSchema.parse({records: [value], providerTotal: null, events: value.is_retracted ? [{
      identity: `doi:${normalized}`, kind: 'retraction', title: value.title, subjectDoi: normalized, noticeDoi: null,
      field: 'is_retracted', providerType: 'is_retracted', sourceHash: resourceContentHash(value)
    }] : [], nextOffset: 0, coverage: 'reported_end'});
  }
  const text = z.string().min(1).max(4000);
  const value = z.object({message: z.object({
    'total-results': z.number().int().nonnegative(),
    items: z.array(z.object({DOI: text, title: z.array(text).optional(),
      'update-to': z.array(z.object({DOI: text, type: text,
        updated: z.object({'date-parts': z.array(z.array(z.number().int()).min(1).max(3)).min(1)})
      })).min(1).max(1000)
    })).max(100)
  })}).parse(payload).message;
  const seen = new Set<string>();
  const events = value.items.flatMap((item, index) => {
    const notice = normalizeResearchDoi(item.DOI);
    if (seen.has(notice)) throw new Error('literature_provider_response_invalid');
    seen.add(notice);
    const updates = item['update-to'].filter(update => normalizeResearchDoi(update.DOI) === normalized);
    if (updates.length === 0) throw new Error('scholarly_provider_identity_mismatch');
    return updates.map(update => ({
      identity: update.type === 'retraction' ? `doi:${normalized}` : `doi:${notice}->doi:${normalized}:${update.type}`,
      kind: update.type === 'retraction' ? 'retraction' as const : update.type === 'correction' ? 'correction' as const : 'other_update' as const,
      title: item.title?.[0] ?? notice, subjectDoi: normalized, noticeDoi: notice,
      field: `message.items[${index}].update-to`, providerType: update.type, sourceHash: resourceContentHash(item)
    }));
  });
  if (value.items.length > value['total-results']) throw new Error('literature_provider_response_invalid');
  const unique = [...new Map(events.map(event => [JSON.stringify([event.identity, event.kind]), event])).values()];
  return monitorProviderMaterialSchema.parse({records: value.items, providerTotal: value['total-results'], events: unique,
    nextOffset: value.items.length === 100 ? offset + 100 : 0,
    coverage: value.items.length === 100 ? 'limited' : 'reported_end'});
}
