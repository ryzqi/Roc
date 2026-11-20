import {scientificCandidateSchema, type ScientificCandidate} from '../../../shared/schemas/research-scientific-search';
import type {ScientificQueryPlan} from '../../../shared/schemas/research-scientific-query-plan';
import {researchContentHash} from './research-files';

export const scientificFusionVersion = 'roc-scientific-fusion/1';
export const scientificRrfK = 60;

/** Preferences only resolve exact score ties; they never replace measured relevance. */
export function compareScientificRelevance(leftScore: number, rightScore: number,
  leftPreferred: boolean, rightPreferred: boolean): number {
  return rightScore - leftScore || Number(rightPreferred) - Number(leftPreferred);
}

function sourceIdentity(candidate: ScientificCandidate): string {
  const {score: _score, signals: _signals, ...source} = candidate;
  return researchContentHash(JSON.stringify(source));
}

/** One contribution per distinct channel/method; repeated lists cannot inflate a candidate. */
export function fuseScientificCandidates(lists: readonly (readonly ScientificCandidate[])[],
  plan?: ScientificQueryPlan): ScientificCandidate[] {
  if (lists.reduce((n, list) => n + list.length, 0) > 1200) throw new Error('research_scientific_fusion_budget_exceeded');
  const merged = new Map<string, {candidate: ScientificCandidate; identity: string}>();
  for (const input of lists.flat()) {
    const candidate = scientificCandidateSchema.parse(input), identity = sourceIdentity(candidate);
    const previous = merged.get(candidate.id);
    if (previous && previous.identity !== identity) throw new Error('research_scientific_fusion_identity_conflict');
    const signals = new Map((previous?.candidate.signals ?? []).map(s => [`${s.channel}:${s.method}`, s]));
    for (const signal of candidate.signals) {
      const key = `${signal.channel}:${signal.method}`, saved = signals.get(key);
      if (!saved || signal.rank < saved.rank) signals.set(key, signal);
    }
    candidate.signals = [...signals.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.method.localeCompare(b.method));
    candidate.score = candidate.signals.reduce((score, s) => score + 1 / (scientificRrfK + s.rank), 0);
    merged.set(candidate.id, {candidate, identity});
  }
  const objectMatch = (c: ScientificCandidate): boolean => {
    const kind = c.object.kind;
    return (kind === 'table' || kind === 'figure' || kind === 'equation') &&
      Boolean(plan?.intents.includes(kind));
  };
  const roleMatch = (c: ScientificCandidate): boolean => c.semanticRoles.some(role => plan?.filters.sectionRoles.includes(role));
  const exact = (c: ScientificCandidate): boolean => c.signals.some(s => s.method === 'exact');
  return [...merged.values()].map(row => row.candidate).sort((a, b) =>
    compareScientificRelevance(a.score, b.score, objectMatch(a), objectMatch(b)) ||
    Number(exact(b)) - Number(exact(a)) || Number(roleMatch(b)) - Number(roleMatch(a)) || a.id.localeCompare(b.id));
}
