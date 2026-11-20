import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult} from '../../../shared/types';
import type {ScientificSearchResult} from '../../../shared/schemas/research-scientific-search';
import type {ResearchEmbeddingService} from './embedding-service';
import type {ScientificRetrievalRouter} from './scientific-retrieval-router';
import {processingFailureCode} from './processing-trace';

export const scientificShadowPolicySchema = z.object({
  projectIds: z.array(z.string().min(1)).max(1000),
  timeoutMs: z.number().int().min(10).max(60_000).default(10_000),
  concurrency: z.number().int().min(1).max(4).default(1)
}).strict();
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Ranked = {id: string; source: string | null; kind: string};
type Observation = {status: 'ok' | 'error'; elapsedMs: number; error: string | null;
  ranked: Ranked[]; degradation: string[]};
export type ScientificShadowEvent = {
  version: 1; id: string; projectId: string; queryHash: string; createdAt: string;
  status: 'compared' | 'failed' | 'cancelled' | 'timeout' | 'skipped'; reason: string | null;
  legacy: Observation; scientific: Observation | null;
  overlap: {unit: 'same-parse-source-block'; common: number; legacy: number; scientific: number;
    jaccard: number | null; rankChanges: Array<{source: string; legacy: number; scientific: number}>} | null;
  scientificSnapshot: string | null; recall: null;
};
type Work = {controller: AbortController; promise: Promise<void>};
const legacyRanks = (result: ResearchKnowledgeSearchResult): Ranked[] => result.hits.map(hit => ({
  id: digest(hit.chunkId), kind: hit.semantic?.blockKind ?? hit.sourceType,
  source: hit.semantic ? digest([hit.semantic.paperId, hit.semantic.parseId, hit.semantic.sourceHash, hit.semantic.blockId]) : null
}));
const scientificRanks = (result: ScientificSearchResult): Ranked[] => result.hits.map(hit => ({
  id: digest(hit.id), kind: hit.objectType,
  source: hit.sourceLocator ? digest([hit.paperId, hit.sourceLocator.parseId,
    hit.sourceLocator.sourceHash, hit.sourceLocator.blockId]) : null
}));
function overlap(a: Ranked[], b: Ranked[]): ScientificShadowEvent['overlap'] {
  const unique = (rows: Ranked[]): string[] => [...new Set(rows.flatMap(r => r.source ? [r.source] : []))];
  const left = unique(a), right = unique(b), common = left.filter(source => right.includes(source));
  const union = new Set([...left, ...right]).size;
  return {unit: 'same-parse-source-block', common: common.length, legacy: left.length, scientific: right.length,
    jaccard: union ? common.length / union : null, rankChanges: common.map(source => ({source,
      legacy: a.findIndex(r => r.source === source) + 1, scientific: b.findIndex(r => r.source === source) + 1}))};
}

/** User results always come from legacy search. Background work owns no publishing/tool capabilities. */
export class ScientificShadowRetrieval {
  private closed = false;
  private readonly work = new Set<Work>();
  constructor(private readonly legacy: Pick<ResearchEmbeddingService, 'search'>,
    private readonly scientific: Pick<ScientificRetrievalRouter, 'search' | 'snapshots'>,
    private readonly policy: () => unknown,
    private readonly observe: (event: ScientificShadowEvent) => void) {}

  async search(request: ResearchKnowledgeSearchRequest, signal?: AbortSignal): Promise<ResearchKnowledgeSearchResult> {
    if (this.closed) throw new Error('research_shadow_closed');
    const started = performance.now();
    let result: ResearchKnowledgeSearchResult;
    try { result = await this.legacy.search(request, signal); }
    catch (error) {
      const elapsedMs = performance.now() - started;
      this.schedule(request, () => ({status: 'error', elapsedMs,
        error: processingFailureCode(error), ranked: [], degradation: []}), signal);
      throw error;
    }
    const elapsedMs = performance.now() - started;
    this.schedule(request, () => ({status: 'ok', elapsedMs, error: null,
      ranked: legacyRanks(result), degradation: result.ranking.degradation ? [result.ranking.degradation] : []}), signal);
    return result;
  }

  private schedule(request: ResearchKnowledgeSearchRequest, legacy: () => Observation, external?: AbortSignal): void {
    try {this.start(request, legacy, external);} catch { /* Shadow setup cannot change the foreground outcome. */ }
  }

  private start(request: ResearchKnowledgeSearchRequest, legacy: () => Observation, external?: AbortSignal): void {
    if (this.closed || request.projectId === null) return;
    let policy;
    try { policy = scientificShadowPolicySchema.safeParse(this.policy()); } catch { return; }
    if (!policy.success || !policy.data.projectIds.includes(request.projectId)) return;
    const event: ScientificShadowEvent = {version: 1, id: randomUUID(), projectId: request.projectId,
      queryHash: digest(request.query), createdAt: new Date().toISOString(), status: 'skipped', reason: null,
      legacy: legacy(), scientific: null, overlap: null, scientificSnapshot: null, recall: null};
    if (this.work.size >= policy.data.concurrency || external?.aborted) {
      this.emit({...event, reason: external?.aborted ? 'request_cancelled' : 'capacity'}); return;
    }
    const controller = new AbortController();
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    // A macrotask lets the foreground result reach its caller before any catalog/SQLite work.
    const task: Work = {controller, promise: Promise.resolve()};
    const input = {...request};
    task.promise = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      let timedOut = false;
      const timer = setTimeout(() => {timedOut = true; controller.abort();}, policy.data.timeoutMs);
      const started = performance.now();
      try {
        signal.throwIfAborted();
        const catalog = this.scientific.snapshots.catalog(input.projectId, []);
        const selected = input.documentId === undefined ? catalog : catalog.filter(g =>
          g.snapshot.paperIR.identity.knowledgeDocumentId === input.documentId);
        if (!selected.length) {this.emit({...event, reason: 'no_scientific_generation'}); return;}
        const result = await this.scientific.search({projectId: input.projectId, query: input.query,
          documentIds: selected.map(g => g.snapshot.paperIR.identity.documentId), embeddingConfigId: input.embeddingConfigId,
          limit: input.limit, candidateLimit: input.candidateLimit ?? 100, rerank: input.rerank ?? 'semantic'}, signal);
        signal.throwIfAborted();
        const ranked = scientificRanks(result);
        this.emit({...event, status: 'compared', scientific: {status: 'ok', error: null,
          elapsedMs: performance.now() - started, ranked, degradation: result.channels.flatMap(c => c.degradation)},
          scientificSnapshot: result.snapshot.id, overlap: event.legacy.status === 'ok' ? overlap(event.legacy.ranked, ranked) : null});
      } catch (error) {
        this.emit({...event, status: timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'failed',
          scientific: {status: 'error', error: processingFailureCode(error), elapsedMs: performance.now() - started,
            ranked: [], degradation: []}});
      } finally {clearTimeout(timer);}
    }).finally(() => {this.work.delete(task);});
    this.work.add(task);
  }

  private emit(event: ScientificShadowEvent): void {
    try {this.observe(event);} catch { /* Diagnostics cannot replace the user's search result. */ }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const task of this.work) task.controller.abort();
    await Promise.allSettled([...this.work].map(task => task.promise));
  }

  /** Offline acceptance and controlled shutdown can await actual provider settlement. */
  async settle(): Promise<void> {await Promise.allSettled([...this.work].map(task => task.promise));}
}
