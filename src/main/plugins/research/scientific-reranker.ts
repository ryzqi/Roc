import type {ScientificCandidate, ScientificSearchResult} from '../../../shared/schemas/research-scientific-search';
import type {ScientificQueryPlan} from '../../../shared/schemas/research-scientific-query-plan';
import type {RerankerReceipt} from '../../../shared/schemas/research-reranker';
import type {ScientificSearchPaper} from './scientific-search-snapshot';
import type {ResearchRerankerService} from './reranker-service';
import {chunkTokenCount} from './knowledge-chunks';
import {researchContentHash} from './research-files';
import {coverScientificCandidates} from './scientific-retrieval-fusion';

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
  const details: RerankDetails = {inputVersion: scientificRerankInputVersion, inputHash: null, scores: [], degradation: [], skipped: []};
  if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 0) ||
    budget.candidates > scientificRerankBudget.candidates || budget.documentTokens > scientificRerankBudget.documentTokens ||
    budget.totalTokens > scientificRerankBudget.totalTokens) throw new Error('research_scientific_rerank_budget_invalid');
  const byGeneration = new Map(papers.map(p => [p.generation.id, p]));
  const preferred = coverScientificCandidates(candidates, plan, budget.candidates);
  const preferredIds = new Set(preferred.map(candidate => candidate.id));
  const priority = [...preferred, ...candidates.filter(candidate => !preferredIds.has(candidate.id))];
  const documents: string[] = [], selected: ScientificCandidate[] = [];
  let tokens = chunkTokenCount(plan.query);
  const skip = (candidate: ScientificCandidate, reason: string) => {
    details.skipped.push({candidateId: candidate.id, reason});
    if (!details.degradation.includes(reason)) details.degradation.push(reason);
  };
  for (const candidate of priority) {
    signal.throwIfAborted();
    const paper = byGeneration.get(candidate.generationId);
    if (!paper) throw new Error('research_scientific_rerank_source_invalid');
    if (selected.length >= budget.candidates) {skip(candidate, 'rerank_candidate_budget_exceeded'); continue;}
    const text = scientificRerankDocument(candidate, paper, plan), count = chunkTokenCount(text);
    if (count > budget.documentTokens) {skip(candidate, 'rerank_document_token_budget_exceeded'); continue;}
    if (tokens + count > budget.totalTokens) {skip(candidate, 'rerank_total_token_budget_exceeded'); continue;}
    tokens += count; documents.push(text); selected.push(candidate);
  }
  if (!selected.length) return fallback(unavailable('not_requested'), details);
  details.inputHash = researchContentHash(JSON.stringify({version: scientificRerankInputVersion, query: plan.query,
    candidateIds: selected.map(c => c.id), documents}));
  let response: Awaited<ReturnType<ResearchRerankerService['rank']>>;
  try {response = await service.rank(plan.query, documents, signal);} catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === 'research_reranker_config_changed') throw error;
    details.degradation.push('rerank_failed');
    return fallback(unavailable('failed'), details);
  }
  const {scores, receipt} = response;
  signal.throwIfAborted();
  if (scores === null) {
    details.degradation.push(`rerank_${receipt.status}`);
    return fallback(receipt, details);
  }
  if (receipt.status !== 'succeeded' || scores.length !== selected.length ||
    scores.some(score => !Number.isFinite(score) || score < 0 || score > 1)) {
    details.degradation.push('rerank_scores_invalid');
    return fallback({...receipt, status: 'failed'}, details);
  }
  details.scores = selected.map((candidate, index) => ({candidateId: candidate.id, score: scores[index]!}));
  const reranked = selected.map((candidate, index) => ({candidate, score: scores[index]!, index}))
    .sort((a, b) => b.score - a.score || b.candidate.score - a.candidate.score || a.index - b.index)
    .map(row => row.candidate);
  // Replace only ranked slots; unranked full objects keep their fusion positions.
  const selectedIds = new Set(selected.map(candidate => candidate.id));
  let index = 0;
  const ordered = candidates.map(candidate => selectedIds.has(candidate.id) ? reranked[index++]! : candidate);
  return {ordered, method: 'reranker', reranker: receipt, rerank: details};
}
