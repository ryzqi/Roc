import { createHash } from 'node:crypto';
import type { ResearchBibliographyEntry } from '../../../shared/types';

export function normalizeResearchDoi(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value.trim())) throw new Error('research_doi_invalid');
  let doi = value.trim().replace(/^doi:\s*/iu, '');
  if (/^https?:\/\//iu.test(doi)) {
    let url: URL;
    try {
      url = new URL(doi);
      doi = decodeURIComponent(url.pathname.slice(1));
    } catch (cause) { throw new Error('research_doi_invalid', { cause }); }
    if (!['doi.org', 'dx.doi.org', 'www.doi.org'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) {
      throw new Error('research_doi_invalid');
    }
  }
  if (!/^10\.\d{4,9}\/[^\s]+$/iu.test(doi) || /[\u0000-\u001f]/u.test(doi)) throw new Error('research_doi_invalid');
  return doi.toLowerCase();
}

export function literatureIdentity(record: { doi: string | null; source: string; externalId: string }): string {
  if (record.doi !== null) return `doi:${normalizeResearchDoi(record.doi)}`;
  if (!record.source || !record.externalId.trim()) throw new Error('research_literature_identity_required');
  return `${record.source}:${record.externalId}`;
}

export function referenceKey(identity: string): string {
  return `roc_${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

export function bibliographyIdentity(entry: ResearchBibliographyEntry): string {
  const identity = JSON.stringify([entry.citationKey, entry.entryType, entry.fields, entry.preambles, entry.csl], (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  return createHash('sha256').update(identity).digest('hex');
}
