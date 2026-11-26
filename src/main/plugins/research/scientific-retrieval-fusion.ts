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

/** Reserve a few near-cutoff slots for requested objects, roles and comparison sources.
 * Raw RRF scores stay intact; unrelated or much weaker candidates never gain a quota. */
export function coverScientificCandidates(candidates: readonly ScientificCandidate[], plan: ScientificQueryPlan,
  limit: number): ScientificCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1200) throw new Error('research_scientific_fusion_budget_exceeded');
  const selected = candidates.slice(0, limit);
  if (!selected.length || candidates.length <= limit) return selected;
  const requirements: Array<(candidate: ScientificCandidate) => boolean> = [];
  for (const kind of ['table', 'equation', 'figure', 'citation'] as const) {
    if (plan.intents.includes(kind) || kind === 'table' && plan.intents.some(i => ['results', 'experiment', 'comparison'].includes(i))) {
      requirements.push(candidate => candidate.object.kind === kind);
    }
  }
  for (const role of plan.filters.sectionRoles) requirements.push(candidate => candidate.semanticRoles.includes(role));
  if (plan.intents.includes('limitations')) requirements.push(candidate => candidate.semanticRoles.includes('limitation'));
  if (plan.intents.some(i => i === 'comparison' || i === 'cross_paper')) {
    for (const paperId of [...new Set(candidates.map(candidate => candidate.paperId))].slice(0, 6)) {
      requirements.push(candidate => candidate.paperId === paperId && candidate.chunkId !== null);
    }
  }
  const cutoff = selected.at(-1)!.score * 0.85, maxReplacements = Math.min(6, Math.max(1, Math.floor(limit / 3)));
  let replacements = 0;
  for (const required of requirements) {
    if (replacements >= maxReplacements || selected.some(required)) continue;
    const addition = candidates.find(candidate => candidate.score >= cutoff && required(candidate) &&
      !selected.some(saved => saved.id === candidate.id));
    if (!addition) continue;
    const index = selected.findLastIndex(candidate => requirements.every(test => !test(candidate) ||
      test(addition) || selected.some(other => other.id !== candidate.id && test(other))));
    if (index < 0) continue;
    selected[index] = addition; replacements++;
  }
  const ids = new Set(selected.map(candidate => candidate.id));
  return candidates.filter(candidate => ids.has(candidate.id));
}
