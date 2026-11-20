import type {ZoteroFrozenObject} from '../../../shared/schemas/research-zotero';
import {researchCitationKeySchema} from '../../../shared/schemas/research-library';
import type {ZoteroCitationKeyMapping} from '../../../shared/schemas/zotero-citation-key';
import {betterBibtexKey, type CiteKeyInput} from './cite-key';

/** Explicit keys only: CSL id and Zotero object key identify records, not citations. */
export function zoteroCitationKeyMapping(
  source: ZoteroFrozenObject, metadata: CiteKeyInput, existing: string | null, taken: Set<string>, preview = false
): ZoteroCitationKeyMapping {
  const candidates: ZoteroCitationKeyMapping['candidates'] = [];
  const add = (origin: ZoteroCitationKeyMapping['candidates'][number]['origin'], value: unknown): void => {
    if (typeof value === 'string' && value !== '') candidates.push({origin, value, valid: researchCitationKeySchema.safeParse(value).success});
  };
  add('native', source.item.data.citationKey);
  // Malformed CSL is rejected by the bibliography worker before any import is committed.
  try {
    const parsed: unknown = JSON.parse(source.cslJson);
    const record: unknown = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    if (typeof record === 'object' && record !== null && !Array.isArray(record) && 'citation-key' in record) add('csl', record['citation-key']);
  } catch { /* A read-only preview may still show native/legacy keys. */ }
  const extra = source.item.data.extra;
  if (typeof extra === 'string') for (const match of extra.matchAll(/^Citation Key:\s*(.*?)\s*$/gimu)) add('extra', match[1]);
  const validKeys = [...new Set(candidates.filter(candidate => candidate.valid).map(candidate => candidate.value))];
  const issues: ZoteroCitationKeyMapping['issues'] = [];
  if (candidates.some(candidate => !candidate.valid)) issues.push('invalid_source_key');
  if (validKeys.length > 1) issues.push('source_disagreement');
  // Ambiguous or invalid explicit sources require review; never choose one silently.
  const sourceKey = issues.length === 0 ? validKeys[0] ?? null : null;
  if (existing !== null) {
    if (validKeys.some(key => key !== existing)) issues.push('local_key_retained');
    return {candidates, sourceKey, localKey: existing, selection: 'existing', issues};
  }
  if (sourceKey !== null && !taken.has(sourceKey.toLowerCase())) {
    taken.add(sourceKey.toLowerCase());
    return {candidates, sourceKey, localKey: sourceKey, selection: 'source', issues};
  }
  if (sourceKey !== null) issues.push('key_collision');
  return {candidates, sourceKey, localKey: preview ? null : betterBibtexKey(metadata, taken), selection: 'generated', issues};
}
