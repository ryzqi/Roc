import { createHash } from 'node:crypto';
import type { ResearchBibliographyEntry } from '../../../shared/types';
import { normalizeResearchArxiv } from '../../../shared/arxiv-identifier';

export { normalizeResearchArxiv } from '../../../shared/arxiv-identifier';

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

export function normalizeResearchPmid(value: string): string {
  let identifier = value.trim().replace(/^pmid:\s*/iu, '');
  if (/^https?:\/\//iu.test(identifier)) {
    let url: URL;
    try { url = new URL(identifier); } catch (cause) { throw new Error('research_pmid_identifier_invalid', {cause}); }
    if (url.hostname !== 'pubmed.ncbi.nlm.nih.gov' || url.username || url.password || url.search || url.hash) throw new Error('research_pmid_identifier_invalid');
    identifier = url.pathname.replace(/^\/|\/$/gu, '');
  }
  if (!/^[1-9]\d*$/u.test(identifier)) throw new Error('research_pmid_identifier_invalid');
  return identifier;
}

export function literatureSourceIdentity(record: {source: string; externalId: string}): string {
  if (!record.source || !record.externalId.trim()) throw new Error('research_literature_identity_required');
  if (record.source === 'arxiv') return `arxiv:${normalizeResearchArxiv(record.externalId).id}`;
  if (record.source === 'pubmed') return `pmid:${normalizeResearchPmid(record.externalId)}`;
  if (record.source === 'europe_pmc') {
    const match = /^(?<namespace>[A-Z]+):(?<id>[^:\s]+)$/u.exec(record.externalId);
    if (match?.groups === undefined) throw new Error('research_europe_pmc_identifier_invalid');
    if (match.groups.namespace === 'MED') return `pmid:${normalizeResearchPmid(match.groups.id)}`;
  }
  return `${record.source}:${record.externalId}`;
}

export function literatureIdentity(record: { doi: string | null; source: string; externalId: string }): string {
  const sourceIdentity = literatureSourceIdentity(record);
  return record.doi === null ? sourceIdentity : `doi:${normalizeResearchDoi(record.doi)}`;
}

/** arXiv's registered DOI namespace encodes its identifier, including legacy IDs. */
export function literatureIdentityAliases(identity: string): string[] {
  if (identity.startsWith('arxiv:')) {
    const {id} = normalizeResearchArxiv(identity.slice(6));
    return [identity, `doi:10.48550/arxiv.${id.toLowerCase()}`];
  }
  const prefix = 'doi:10.48550/arxiv.';
  if (!identity.toLowerCase().startsWith(prefix)) return [identity];
  try {
    return [identity, `arxiv:${normalizeResearchArxiv(identity.slice(prefix.length)).id}`];
  } catch {
    // A syntactically valid DOI need not contain a valid arXiv identifier.
    return [identity];
  }
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
