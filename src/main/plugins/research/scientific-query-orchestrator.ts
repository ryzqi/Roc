import {performance} from 'node:perf_hooks';
import {scientificQueryRequestSchema, scientificQueryResultSchema,
  type ScientificQueryResult} from '../../../shared/schemas/research-scientific-query';
import type {ScientificSearchRequest, ScientificSearchResult, ScientificCandidate} from '../../../shared/schemas/research-scientific-search';
import type {ResearchEmbeddingService} from './embedding-service';
import type {ScientificRetrievalRouter} from './scientific-retrieval-router';
import {normalizeScientificQuery, scientificSubqueryPlan} from './scientific-query-planner';
import {researchContentHash} from './research-files';

const hash = (value: unknown): string => researchContentHash(JSON.stringify(value));
/** Coordinates existing engines; raw objects and per-round reconstruction receipts stay intact. */
export class ScientificQueryOrchestrator {
  constructor(private readonly scientific: Pick<ScientificRetrievalRouter, 'plan' | 'search' | 'sourceRefs' | 'assertCurrent'>,
    private readonly legacy: Pick<ResearchEmbeddingService, 'search'>,
    private readonly timeBudgetMs = 20_000,
    private readonly sourcePath?: (projectId: string, documentId: string, sourceHash: string) => string | null) {}

  async search(input: ScientificSearchRequest, signal: AbortSignal = new AbortController().signal): Promise<ScientificQueryResult> {
    signal.throwIfAborted();
    const request = scientificQueryRequestSchema.parse(input);
    if (!request.projectId) throw new Error('research_scientific_query_project_required');
    const started = performance.now(), deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('research_scientific_query_time_budget')), this.timeBudgetMs);
    const bounded = AbortSignal.any([signal, deadline.signal]);
    const rounds: ScientificSearchResult[] = [], candidates = new Set<string>(), degradation: string[] = [];
    let legacy: ScientificQueryResult['legacy'] = null;
    let stopReason: ScientificQueryResult['stopReason'] = 'complete';
    try {
      const plan = await this.scientific.plan(request, bounded);
      const queries = [{query: request.query, plan}, ...plan.subQuestions.map(question =>
        ({query: question.question, plan: scientificSubqueryPlan(plan, question)}))];
      const seen = new Set<string>();
      let spent = 0;
      for (const next of queries) {
        const normalized = normalizeScientificQuery(next.query);
        if (seen.has(normalized)) continue;
        if (rounds.length >= plan.maxRetrievalRounds) {stopReason = 'round_budget'; break;}
        const perChannel = Math.min(request.candidateLimit, Math.floor((plan.maxCandidates - spent) / next.plan.retrievalChannels.length));
        if (perChannel < 1) {stopReason = 'candidate_budget'; break;}
        seen.add(normalized);
        const result = await this.scientific.search({...request, query: next.query,
          candidateLimit: perChannel, limit: Math.min(request.limit, perChannel)}, bounded, next.plan);
        rounds.push(result);
        spent += result.candidates.length;
        const before = candidates.size;
        for (const hit of result.candidates) candidates.add(hit.id);
        degradation.push(...result.channels.flatMap(channel => channel.degradation));
        if (result.ranking.rerank?.degradation) degradation.push(...result.ranking.rerank.degradation);
        if (candidates.size === before) {stopReason = 'no_gain'; break;}
      }
      // Explicit paper scopes (including unresolved identifiers) must never fall back to all project documents.
      if (!request.documentIds.length && !plan.observation.unresolvedIdentifiers.length && plan.scope.selection !== 'selected') {
        legacy = await this.legacy.search({projectId: request.projectId, query: request.query,
          limit: Math.min(request.limit, 50), candidateLimit: Math.max(50, request.candidateLimit),
          embeddingConfigId: request.embeddingConfigId, rerank: request.rerank}, bounded);
        const scientificDocuments = new Set(rounds.flatMap(round => round.snapshot.generations.map(g => g.paperIR.identity.knowledgeDocumentId)));
        legacy = {...legacy, hits: legacy.hits.filter(hit => !scientificDocuments.has(hit.documentId))};
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!deadline.signal.aborted || !rounds.length ||
        error !== deadline.signal.reason && !(error instanceof Error && error.name === 'AbortError')) throw error;
      stopReason = 'time_budget'; degradation.push('time_budget');
    } finally {clearTimeout(timer);}
    signal.throwIfAborted();
    // Round-robin selection reserves coverage for each subquestion without altering any source object.
    const hits: ScientificCandidate[] = [], selected = new Set<string>();
    for (let i = 0; i < request.limit && hits.length < request.limit; i++) {
      for (const round of rounds) {
        const hit = round.hits[i];
        if (hit && !selected.has(hit.id) && hits.length < request.limit) {selected.add(hit.id); hits.push(hit);}
      }
    }
    const sourceRefs = new Map<string, ScientificQueryResult['sourceRefs'][number]>();
    for (const round of rounds) {
      await this.scientific.assertCurrent(round, signal);
      for (const ref of await this.scientific.sourceRefs(round, signal)) {
        if (hits.some(hit => hit.generationId === ref.generationId && hit.objectId === ref.objectId)) sourceRefs.set(hash(ref), ref);
      }
    }
    signal.throwIfAborted();
    const sourceTargets = [...new Map([...sourceRefs.values()].flatMap(ref => {
      const path = this.sourcePath?.(request.projectId!, ref.knowledgeDocumentId, ref.sourceHash);
      return path ? [[ref.documentId, {documentId: ref.documentId, path}] as const] : [];
    })).values()];
    const basis = {sourceTargets, query: request.query, projectId: request.projectId, rounds, legacy, hits, sourceRefs: [...sourceRefs.values()]};
    return scientificQueryResultSchema.parse({version: 'roc-scientific-query/1', ...basis,
      intent: [...new Set(rounds.flatMap(round => round.plan.intents))],
      searchSnapshotId: hash(rounds.map(round => round.snapshot.id)), retrievalReceiptId: `scientific-query:${hash(basis)}`,
      degradation: [...new Set(degradation)], stopReason, elapsedMs: performance.now() - started});
  }
}
