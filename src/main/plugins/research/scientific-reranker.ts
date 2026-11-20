import type {ScientificCandidate, ScientificSearchResult} from '../../../shared/schemas/research-scientific-search';
import type {ScientificQueryPlan} from '../../../shared/schemas/research-scientific-query-plan';
import type {RerankerReceipt} from '../../../shared/schemas/research-reranker';
import type {ScientificSearchPaper} from './scientific-search-snapshot';
import type {ResearchRerankerService} from './reranker-service';
import {chunkTokenCount} from './knowledge-chunks';
import {researchContentHash} from './research-files';

export const scientificRerankInputVersion = 'roc-scientific-rerank/1';
export const scientificRerankBudget = {candidates: 200, documentTokens: 4096, totalTokens: 64_000} as const;
type Ranking = ScientificSearchResult['ranking'];
type RerankDetails = NonNullable<Ranking['rerank']>;
const unavailable = (status: RerankerReceipt['status']): RerankerReceipt =>
  ({status, model: null, configHash: null, elapsedMs: 0});

/** YAML scalars use JSON escaping; original content, cells and formulas stay complete. */
export function scientificRerankDocument(candidate: ScientificCandidate, paper: ScientificSearchPaper,
  plan: ScientificQueryPlan): string {
  if (candidate.generationId !== paper.generation.id || candidate.documentId !== paper.ir.identity.documentId ||
    candidate.paperId !== paper.ir.identity.paperId) throw new Error('research_scientific_rerank_source_invalid');
  const object = candidate.object;
  const caption = object.kind === 'table' ? object.caption : object.kind === 'figure'
    ? object.data.captions.map(c => c.evidence.text).join('\n') || null : null;
  const sourceText = [candidate.content, caption ?? '', ...candidate.sources.map(s => s.text),
    ...candidate.sectionPath].join('\n').toLowerCase();
  const sourceMatches = (terms: string[]): string[] => terms.filter(term => sourceText.includes(term.toLowerCase()));
  const fields = {
    paperTitle: candidate.title, sectionPath: candidate.sectionPath, semanticRoles: candidate.semanticRoles,
    objectType: candidate.objectType, caption, content: candidate.content,
    // Until typed extraction is available, only query terms actually found in original evidence are metadata.
    metadata: {datasets: sourceMatches(plan.filters.datasets), metrics: sourceMatches(plan.filters.metrics), methods: []},
    relations: paper.ir.relations.filter(r => candidate.relationIds.includes(r.id)).map(r => ({
      type: r.type, targetId: r.fromId === candidate.objectId ? r.toId : r.fromId, status: r.status
    })),
    originalEvidence: object
  };
  return Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
}

/** The provider may assign scores by input index; it never owns candidate identity or evidence. */
export async function rerankScientificCandidates(plan: ScientificQueryPlan, candidates: readonly ScientificCandidate[],
  papers: readonly ScientificSearchPaper[], service: Pick<ResearchRerankerService, 'rank'> | null, enabled: boolean,
  signal: AbortSignal, budget: {candidates: number; documentTokens: number; totalTokens: number} = scientificRerankBudget
): Promise<{ordered: ScientificCandidate[]; method: Ranking['method']; reranker: RerankerReceipt; rerank: RerankDetails | null}> {
  signal.throwIfAborted();
  const fallback = (reranker: RerankerReceipt, rerank: RerankDetails | null = null) =>
    ({ordered: [...candidates], method: 'rrf' as const, reranker, rerank});
  if (!enabled) return fallback(unavailable('not_requested'));
  if (service === null) return fallback(unavailable('config_missing'));
  const details: RerankDetails = {inputVersion: scientificRerankInputVersion, inputHash: null, scores: [], degradation: []};
  if (candidates.length > budget.candidates) {
    details.degradation.push('rerank_candidate_budget_exceeded');
    return fallback(unavailable('not_requested'), details);
  }
  const byGeneration = new Map(papers.map(p => [p.generation.id, p]));
  const documents: string[] = [];
  let tokens = chunkTokenCount(plan.query);
  for (const candidate of candidates) {
    signal.throwIfAborted();
    const paper = byGeneration.get(candidate.generationId);
    if (!paper) throw new Error('research_scientific_rerank_source_invalid');
    const text = scientificRerankDocument(candidate, paper, plan), count = chunkTokenCount(text);
    tokens += count;
    if (count > budget.documentTokens || tokens > budget.totalTokens) {
      details.degradation.push('rerank_token_budget_exceeded');
      return fallback(unavailable('not_requested'), details);
    }
    documents.push(text);
  }
  details.inputHash = researchContentHash(JSON.stringify({version: scientificRerankInputVersion, query: plan.query,
    candidateIds: candidates.map(c => c.id), documents}));
  const {scores, receipt} = await service.rank(plan.query, documents, signal);
  signal.throwIfAborted();
  if (scores === null) {
    details.degradation.push(`rerank_${receipt.status}`);
    return fallback(receipt, details);
  }
  if (receipt.status !== 'succeeded' || scores.length !== candidates.length ||
    scores.some(score => !Number.isFinite(score) || score < 0 || score > 1)) {
    throw new Error('research_scientific_rerank_scores_invalid');
  }
  details.scores = candidates.map((candidate, index) => ({candidateId: candidate.id, score: scores[index]!}));
  const ordered = candidates.map((candidate, index) => ({candidate, score: scores[index]!, index}))
    .sort((a, b) => b.score - a.score || b.candidate.score - a.candidate.score || a.index - b.index)
    .map(row => row.candidate);
  return {ordered, method: 'reranker', reranker: receipt, rerank: details};
}
