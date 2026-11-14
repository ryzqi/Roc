import { z } from 'zod';
import { answerF1 } from '../lib/qasper.mjs';
import { fail } from '../lib/common.mjs';
import { coverageMetrics, rankingMetrics } from './source-evidence.mjs';
import { ragDiagnostics } from '../analysis/failures.mjs';

export const ragMetrics = ['answerF1', 'evidenceF1', 'citationValidity', 'retrievalRecall20',
  'evidenceChainRecall20', 'contextCoverage', 'evidenceReadCoverage', 'abstentionAccuracy',
  'wrongSourceRate', 'staleHitRate'];
const outputSchema = z.strictObject({ answer: z.string().trim().min(1), evidence: z.array(z.string().min(1)), abstain: z.boolean() });
function requireTruth(task) {
  if (!task.expected || !['answerable', 'unanswerable'].includes(task.expected.answerability)
    || !Array.isArray(task.expected.answers) || !Array.isArray(task.expected.evidence) || !Array.isArray(task.expected.evidenceChains)) fail('scoring', 'rag_hidden_truth_unreadable');
  return task.expected;
}
const applicability = metrics => Object.fromEntries(Object.entries(metrics).filter(([, value]) => value === null)
  .map(([name]) => [name, 'not_applicable']));
function sourceBoundaryMetrics(state, searches) {
  const byId = new Map(state.chunks.map(chunk => [chunk.chunkId, chunk]));
  let hits = 0, wrongSource = 0, stale = 0;
  for (const search of searches) for (const hit of search.result.hits) {
    const chunk = byId.get(hit.chunkId);
    if (!chunk) fail('scoring', 'rag_unmapped_retrieval_hit');
    const candidate = search.result.ranking.candidates.find(value => value.chunkId === hit.chunkId);
    hits++;
    if (search.request.projectId !== null && chunk.projectId !== null
      && chunk.projectId !== search.request.projectId) wrongSource++;
    if (!candidate || candidate.indexedVersion !== chunk.indexedVersion) stale++;
  }
  return { wrongSourceRate: hits ? wrongSource / hits : 0, staleHitRate: hits ? stale / hits : 0 };
}
export function gradeRetrieval(task, { state, observations }) {
  const expected = requireTruth(task), search = observations.find(o => o.name === 'research.knowledge.search');
  if (!search) fail('scoring', 'rag_retrieval_receipt_missing');
  const ids = search.result.hits.map(h => h.chunkId), ranks = rankingMetrics(ids, state, expected);
  const metrics = { ...ranks, ...sourceBoundaryMetrics(state, [search]) };
  return { status: 'scored', failureClass: null, reason: null, success: expected.evidence.length ? ranks.evidenceChainRecall20 === 1 && ranks.recall20 === 1 : null,
    metrics, metricApplicability: applicability(metrics), retrievalLatenciesMs: [search.elapsedMs],
    diagnostics: { firstStage: ranks.recall20 !== null && ranks.recall20 < 1 ? 'retrieval' : null,
      labels: ranks.recall20 !== null && ranks.recall20 < 1 ? ['retrieval_miss'] : [], retrievalCoverage: ranks.recall20,
      noAnswerNonempty: expected.answerability === 'unanswerable' ? Number(ids.length > 0) : null,
      retrievalLatencyMs: search.elapsedMs, reranker: search.result.ranking.reranker,
      degradation: search.result.ranking.degradation ?? null },
    category: task.category };
}
export function gradeRag(task, output, evidence) {
  const expected = requireTruth(task);
  if (!evidence?.state || !Array.isArray(evidence.observations) || !Array.isArray(evidence.visibleSpans)) fail('scoring', 'rag_verified_evidence_missing');
  const searches = evidence.observations.filter(o => o.name === 'research.knowledge.search');
  const candidateIds = [...new Set(searches.flatMap(o => o.result.ranking.candidates.slice(0, 20).map(c => c.chunkId)))];
  const candidates = candidateIds.map(id => evidence.state.chunks.find(c => c.chunkId === id));
  if (candidates.some(c => !c)) fail('scoring', 'rag_candidate_mapping_missing');
  const ingestion = coverageMetrics(evidence.state.chunks, expected), retrieval = coverageMetrics(candidates, expected);
  const context = coverageMetrics(evidence.visibleSpans, expected);
  let parsed, reason = null;
  try { parsed = JSON.parse(output); } catch { reason = 'output_not_json'; }
  if (!reason) {
    const result = outputSchema.safeParse(parsed);
    if (!result.success) reason = 'output_schema_invalid'; else parsed = result.data;
  }
  const metrics = Object.fromEntries(ragMetrics.map(m => [m, 0]));
  metrics.retrievalRecall20 = retrieval.recall;
  metrics.evidenceChainRecall20 = retrieval.chainRecall;
  metrics.contextCoverage = context.recall;
  Object.assign(metrics, sourceBoundaryMetrics(evidence.state, searches));
  let success = false;
  if (!reason) {
    if (new Set(parsed.evidence).size !== parsed.evidence.length || parsed.evidence.some(id => !evidence.state.chunks.some(c => c.chunkId === id))) reason = 'citation_invalid';
    const provided = evidence.visibleSpans.filter(s => parsed.evidence.includes(s.chunkId));
    const cited = coverageMetrics(provided, expected), correctAbstention = parsed.abstain === (expected.answerability === 'unanswerable');
    metrics.answerF1 = expected.answerability === 'unanswerable' ? answerF1(parsed.answer, 'Unanswerable')
      : Math.max(...expected.answers.map(answer => answerF1(parsed.answer, answer)));
    metrics.abstentionAccuracy = Number(correctAbstention);
    metrics.evidenceReadCoverage = parsed.evidence.length ? parsed.evidence.filter(id => provided.some(s => s.chunkId === id)).length / parsed.evidence.length
      : expected.answerability === 'unanswerable' ? 1 : 0;
    metrics.citationValidity = reason ? 0 : 1;
    const precision = parsed.evidence.length ? parsed.evidence.filter(id => expected.evidence.some(e =>
      provided.some(s => s.chunkId === id && s.sourceId === e.sourceId && s.sourceVersion === e.sourceVersion
        && s.startOffset < e.locator.endOffset && s.endOffset > e.locator.startOffset))).length / parsed.evidence.length
      : expected.evidence.length ? 0 : 1;
    const recall = cited.recall ?? 1;
    metrics.evidenceF1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    if (!reason && metrics.evidenceReadCoverage < 1) reason = 'citation_not_read';
    if (!reason && expected.evidence.length && (precision < 1 || !parsed.evidence.length)) reason = 'unsupported_citation';
    success = !reason && correctAbstention && metrics.answerF1 === 1 && metrics.evidenceF1 === 1
      && (expected.answerability !== 'unanswerable' || parsed.evidence.length === 0);
  }
  const grade = { status: reason ? 'failed' : 'scored', failureClass: reason ? 'agent' : null, reason, success,
    metrics, metricApplicability: applicability(metrics), category: task.category,
    retrievalLatenciesMs: searches.map(search => search.elapsedMs) };
  return { ...grade, diagnostics: ragDiagnostics({ expected, ingestion: ingestion.recall, retrieval: retrieval.recall,
    context: context.recall, grade }), answer: parsed ?? null };
}
