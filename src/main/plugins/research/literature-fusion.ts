import { createHash } from 'node:crypto';
import { literatureNetworkSourceSchema, type LiteratureCandidate, type LiteratureSearchResult } from '../../../shared/schemas/literature-import';
import type { ResearchLiterature } from '../../../shared/types';
import { literatureIdentity, normalizeResearchArxiv, normalizeResearchDoi } from './literature-identity';

type Source = LiteratureCandidate['origins'][number]['source'];
type FusedPaper = Omit<LiteratureCandidate, 'matchedLibraryItemId' | 'archived' | 'missingFields'>;
export type RankedLiteratureRecord = {record: ResearchLiterature; rank: number};

/** This ordering selects metadata; every selected source has equal ranking weight. */
export const literatureSourcePriority: readonly Source[] = ['crossref', 'openalex', 'semantic_scholar', 'pubmed', 'europe_pmc', 'arxiv'];
const conflictFields = ['doi', 'title', 'authors', 'publishedYear', 'citationCount', 'url', 'openAccessUrl'] as const;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export function literatureRanking(sources: readonly string[]): LiteratureSearchResult['ranking'] {
  return {method: 'rrf', version: 1, k: 60,
    sourceWeights: literatureSourcePriority.filter(source => sources.includes(source)).map(source => ({source, weight: 1}))};
}

/**
 * Ranks are the original one-based positions within each source response. Duplicate
 * records retain their metadata, but a source contributes only its first paper rank.
 * Titles never establish identity. Ties use the normalized identity, without locale.
 */
export function fuseLiterature(records: readonly RankedLiteratureRecord[]): FusedPaper[] {
  const papers = new Map<string, LiteratureCandidate['origins']>();
  for (const {record, rank} of records) {
    const source = literatureNetworkSourceSchema.parse(record.source);
    const identity = literatureIdentity(record);
    const origin = {source, externalId: record.externalId, rank, retrievedAt: record.importedAt,
      metadataHash: hash(record), record};
    const origins = papers.get(identity);
    if (origins === undefined) papers.set(identity, [origin]);
    else origins.push(origin);
  }
  const result: FusedPaper[] = [];
  for (const [identity, origins] of papers) {
    origins.sort((left, right) => literatureSourcePriority.indexOf(left.source) - literatureSourcePriority.indexOf(right.source)
      || left.rank - right.rank || compare(left.metadataHash, right.metadataHash));
    const primary = origins[0];
    const contributions: LiteratureCandidate['contributions'] = [];
    for (const origin of origins) {
      if (contributions.some(contribution => contribution.source === origin.source)) continue;
      contributions.push({source: origin.source, rank: origin.rank, score: 1 / (60 + origin.rank)});
    }
    const conflicts: LiteratureCandidate['conflicts'] = [];
    for (const field of conflictFields) {
      const values: LiteratureCandidate['conflicts'][number]['values'] = [];
      for (const origin of origins) {
        const value = origin.record[field];
        if (value === null || value === '' || Array.isArray(value) && value.length === 0) continue;
        values.push({source: origin.source, externalId: origin.externalId, value});
      }
      const distinct = values.map(value => field === 'doi' ? normalizeResearchDoi(String(value.value)) : JSON.stringify(value.value));
      if (new Set(distinct).size > 1) conflicts.push({field, values});
    }
    result.push({candidateId: `candidate_${hash(identity)}`, identity, record: primary.record,
      origins, contributions, conflicts, versionRelations: arxivVersionRelations(origins),
      score: contributions.reduce((score, contribution) => score + contribution.score, 0),
      selectionReason: 'source_priority_then_rank_then_metadata_hash'});
  }
  return result.sort((left, right) => right.score - left.score || compare(left.identity, right.identity));
}

function arxivVersionRelations(origins: LiteratureCandidate['origins']): LiteratureCandidate['versionRelations'] {
  const observed = new Map<string, Map<number, LiteratureCandidate['versionRelations'][number]['older']>>();
  for (const origin of origins.filter(origin => origin.source === 'arxiv')) {
    const identifier = normalizeResearchArxiv(origin.externalId);
    if (identifier.version === null) continue;
    let versions = observed.get(identifier.id);
    if (versions === undefined) { versions = new Map(); observed.set(identifier.id, versions); }
    const current = versions.get(identifier.version);
    if (current === undefined || compare(origin.metadataHash, current.metadataHash) < 0) {
      versions.set(identifier.version, {version: identifier.version, externalId: origin.externalId, metadataHash: origin.metadataHash});
    }
  }
  const relations: LiteratureCandidate['versionRelations'] = [];
  for (const [arxivId, versions] of [...observed].sort(([left], [right]) => compare(left, right))) {
    const ordered = [...versions.values()].sort((left, right) => left.version - right.version);
    for (let index = 1; index < ordered.length; index++) {
      relations.push({kind: 'arxiv_later_version', arxivId, older: ordered[index - 1], newer: ordered[index]});
    }
  }
  return relations;
}
