import type {LiteratureCandidate, LiteratureSearchInput, LiteratureSearchResult} from '../../../shared/schemas/literature-import';

type Candidate = Pick<LiteratureCandidate, 'candidateId' | 'record' | 'score'>;
const stop = new Set(['the', 'a', 'an', 'of', 'for', 'in', 'on', 'and', 'or', 'to', 'with', 'from', 'papers', 'research']);
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(term => !stop.has(term)).map(term => term.length > 4 && term.endsWith('s') ? term.slice(0, -1) : term));
}
function coverage(query: Set<string>, text: Set<string>): number {
  return query.size === 0 ? 0 : [...query].filter(term => text.has(term)).length / query.size;
}
function similarity(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter(term => right.has(term)).length;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

/** Opt-in lexical baseline. Does not change RRF scores, identity groups, or provider ranks. */
export function rerankLiterature<T extends Candidate>(query: string, candidates: readonly T[]): {
  candidates: T[]; receipt: NonNullable<LiteratureSearchResult['reranking']>;
} {
  const queryTerms = terms(query), remaining = candidates.slice(0, 100).map((candidate, index) => {
    const title = terms(candidate.record.title);
    return {candidate, index, title, diversityPenalty: 0,
      relevance: .7 * coverage(queryTerms, title) + .3 * coverage(queryTerms, terms(candidate.record.abstract ?? ''))};
  });
  const selected: T[] = [];
  const scores: NonNullable<LiteratureSearchResult['reranking']>['scores'] = [];
  while (remaining.length > 0) {
    let winnerIndex = 0, winnerScore = -Infinity;
    // Remaining entries retain input order, so equal scores keep the original tie-break.
    for (const [index, entry] of remaining.entries()) {
      const score = .8 * entry.relevance + .2 / (1 + entry.index) - entry.diversityPenalty;
      if (score > winnerScore) {winnerIndex = index; winnerScore = score;}
    }
    const [winner] = remaining.splice(winnerIndex, 1);
    selected.push(winner.candidate);
    scores.push({candidateId: winner.candidate.candidateId, relevance: winner.relevance,
      diversityPenalty: winner.diversityPenalty, score: winnerScore});
    for (const entry of remaining) {
      entry.diversityPenalty = Math.max(entry.diversityPenalty, .15 * similarity(entry.title, winner.title));
    }
  }
  return {candidates: [...selected, ...candidates.slice(100)],
    receipt: {method: 'lexical_diversity', version: 1, candidateLimit: 100, scores}};
}

/** Year-level fallback only; exact dates remain provider assertions, not inferred metadata. */
export function literatureMatchesYears(record: {publishedYear: number | null}, request: LiteratureSearchInput): boolean {
  const from = Math.max(request.yearFrom ?? -Infinity, request.dateFrom === undefined ? -Infinity : Number(request.dateFrom.slice(0, 4)));
  const to = Math.min(request.yearTo ?? Infinity, request.dateTo === undefined ? Infinity : Number(request.dateTo.slice(0, 4)));
  if (from === -Infinity && to === Infinity) return true;
  return record.publishedYear !== null && record.publishedYear >= from && record.publishedYear <= to;
}
