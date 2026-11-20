import {performance} from 'node:perf_hooks';
import {scientificSearchRequestSchema, scientificSearchResultSchema, scientificSearchVersion,
  type ScientificSearchRequest, type ScientificSearchResult, type ScientificCandidate,
  type ScientificChannelReceipt} from '../../../shared/schemas/research-scientific-search';
import type {ScientificQueryPlan, ScientificRetrievalChannel} from '../../../shared/schemas/research-scientific-query-plan';
import type {ResearchRepository} from './repository';
import type {ResearchEmbeddingService} from './embedding-service';
import {planScientificQuery, type ScientificQueryGenerator} from './scientific-query-planner';
import {ScientificSearchSnapshots, scientificSnapshotId, type ScientificSearchPaper} from './scientific-search-snapshot';
import {scientificChunkCandidate} from './scientific-search-candidate';
import type {ScholarlyRelationsRepository} from './scholarly-relations-repository';
import {normalizeEmbeddingBlob} from './embedding-vectors';
import {researchContentHash} from './research-files';
import {normalizeResearchDoi} from './literature-identity';
import {fuseScientificCandidates, scientificFusionVersion} from './scientific-retrieval-fusion';
import {rerankScientificCandidates} from './scientific-reranker';
import type {ResearchRerankerService} from './reranker-service';
import {scientificContextRequestSchema, type ScientificContextRequest,
  type ScientificContextResult} from '../../../shared/schemas/research-scientific-context';
import {assembleScientificContext} from './scientific-context-assembler';
import {scientificEvidenceRequestSchema, type ScientificEvidenceRequest,
  type ScientificEvidenceResult} from '../../../shared/schemas/research-scientific-evidence';
import {assertScientificSearchSources, validateScientificStatements} from './research-scientific-evidence';
import {scientificMetadataCandidate, scientificCitationCandidate} from './scientific-search-candidate';

type Candidate = Omit<ScientificCandidate, 'signals' | 'score'>;
type Signal = ScientificCandidate['signals'][number];
type ChannelResult = {candidates: ScientificCandidate[]; degradation: string[]};
const hash = (value: unknown): string => researchContentHash(JSON.stringify(value));
const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'from', 'in', 'on', 'to', 'with', 'what',
  'which', 'how', 'why', 'is', 'are', 'was', 'were', 'show', 'explain', 'compare', 'paper', 'papers',
  'table', 'tables', 'figure', 'figures', 'fig', 'equation', 'equations', 'eq', 'doi',
  '解释', '比较', '对比', '论文', '公式', '方程', '表', '图', '的', '和', '在', '上']);

export function scientificQueryTerms(query: string): string[] {
  return [...new Set((query.match(/[\p{L}\p{N}_]+/gu) ?? []).map(t => t.toLowerCase())
    .filter(t => !stopWords.has(t)))].slice(0, 32);
}
const lexicalScore = (text: string, terms: readonly string[]): number =>
  terms.reduce((score, term) => score + Number(text.toLowerCase().includes(term.toLowerCase())), 0);
const numbered = (value: string | null): string | null => value?.trim().replace(/^\(|\)$/gu, '').toUpperCase() ?? null;
function ranked(rows: Array<{candidate: Candidate; score: number; exact?: boolean}>,
  channel: ScientificRetrievalChannel, method: Signal['method'], limit: number): ScientificCandidate[] {
  return rows.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, limit).map((row, i) => ({...row.candidate, score: 1 / (61 + i),
      signals: [{channel, method: row.exact ? 'exact' : method, rank: i + 1, score: row.score}]}));
}

/** Six read-only channels share one authorized generation/IR snapshot, budget and abort signal. */
export class ScientificRetrievalRouter {
  readonly snapshots: ScientificSearchSnapshots;
  constructor(private readonly repository: ResearchRepository,
    private readonly embeddings: Pick<ResearchEmbeddingService, 'selectedIdentity' | 'queryVector'>,
    roots: {library: string | null; index: string | null},
    private readonly scholarly: Pick<ScholarlyRelationsRepository, 'history' | 'read'>,
    private readonly generator: ScientificQueryGenerator | null = null,
    private readonly reranker: Pick<ResearchRerankerService, 'rank'> | null = null) {
    this.snapshots = new ScientificSearchSnapshots(repository, roots);
  }

  async search(input: ScientificSearchRequest, signal: AbortSignal = new AbortController().signal): Promise<ScientificSearchResult> {
    signal.throwIfAborted();
    const request = scientificSearchRequestSchema.parse(input), catalog = this.snapshots.catalog(request.projectId, request.documentIds);
    const plan = await planScientificQuery({query: request.query, projectId: request.projectId,
      documentIds: request.documentIds, papers: this.snapshots.papers(request.projectId, catalog)}, this.generator, signal);
    const papers = await this.snapshots.capture(request.projectId,
      catalog.filter(g => plan.scope.documentIds.includes(g.snapshot.paperIR.identity.documentId) &&
        (!plan.filters.years.length || plan.filters.years.includes(g.snapshot.paperIR.metadata.year!))), signal);
    // Bibliographic snapshots are captured synchronously before any embedding provider yields.
    const citations = plan.retrievalChannels.includes('citation') ? this.citation(papers, plan, request.candidateLimit, signal) : null;
    const channels = await Promise.all(plan.retrievalChannels.map(async channel => {
      signal.throwIfAborted();
      const start = performance.now(), result = channel === 'text' ? await this.text(papers, plan, request, signal) :
        channel === 'metadata' ? this.metadata(papers, plan, request.candidateLimit) :
        channel === 'citation' ? citations! : this.object(papers, plan, channel, request.candidateLimit);
      signal.throwIfAborted();
      const receipt: ScientificChannelReceipt = {channel, limit: request.candidateLimit, returned: result.candidates.length,
        status: result.degradation.length ? 'degraded' : result.candidates.length ? 'ok' : 'empty',
        degradation: result.degradation, elapsedMs: performance.now() - start};
      return {receipt, ...result};
    }));
    signal.throwIfAborted();
    const receipts = papers.map(p => p.receipt);
    await this.snapshots.assertCurrent(request.projectId, receipts, signal);
    const candidates = fuseScientificCandidates(channels.map(c => c.candidates), plan);
    const reranked = await rerankScientificCandidates(plan, candidates, papers, this.reranker,
      request.rerank !== 'none', signal);
    await this.snapshots.assertCurrent(request.projectId, receipts, signal);
    return scientificSearchResultSchema.parse({version: scientificSearchVersion, plan,
      snapshot: {id: scientificSnapshotId(receipts), generations: receipts}, channels: channels.map(c => c.receipt),
      candidates, hits: reranked.ordered.slice(0, request.limit), ranking: {method: reranked.method, k: 60,
        fusionVersion: scientificFusionVersion, reranker: reranked.reranker, rerank: reranked.rerank}});
  }

  async assertCurrent(input: ScientificSearchResult, signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.currentPapers(input, signal);
  }

  private async currentPapers(input: ScientificSearchResult, signal: AbortSignal): Promise<ScientificSearchPaper[]> {
    const result = scientificSearchResultSchema.parse(input);
    if (result.snapshot.id !== scientificSnapshotId(result.snapshot.generations) ||
      new Set(result.snapshot.generations.map(g => g.generationId)).size !== result.snapshot.generations.length ||
      new Set(result.snapshot.generations.map(g => g.paperIR.identity.documentId)).size !== result.snapshot.generations.length ||
      result.snapshot.generations.some(g => !result.plan.scope.documentIds.includes(g.paperIR.identity.documentId))) {
      throw new Error('research_scientific_search_snapshot_invalid');
    }
    await this.snapshots.assertCurrent(result.plan.scope.projectId, result.snapshot.generations, signal);
    const papers = await this.snapshots.capture(result.plan.scope.projectId,
      result.snapshot.generations.map(g => this.repository.scientificIndex.get(g.generationId)), signal);
    assertScientificSearchSources(result, papers, this.scholarly, signal);
    await this.snapshots.assertCurrent(result.plan.scope.projectId, result.snapshot.generations, signal);
    return papers;
  }

  async readContext(input: ScientificContextRequest,
    signal: AbortSignal = new AbortController().signal): Promise<ScientificContextResult> {
    const request = scientificContextRequestSchema.parse(input);
    const papers = await this.currentPapers(request.search, signal);
    const projectId = request.search.plan.scope.projectId;
    const result = await assembleScientificContext(request, papers, this.snapshots.readImage, signal);
    await this.snapshots.assertCurrent(projectId, request.search.snapshot.generations, signal);
    return result;
  }

  async validateEvidence(input: ScientificEvidenceRequest,
    signal: AbortSignal = new AbortController().signal): Promise<ScientificEvidenceResult> {
    const request = scientificEvidenceRequestSchema.parse(input);
    const rebuilt = await this.readContext({search: request.search,
      candidateIds: request.context.selectedCandidateIds, budget: request.context.budget}, signal);
    if (hash(rebuilt) !== hash(request.context)) throw new Error('research_scientific_evidence_context_changed');
    signal.throwIfAborted();
    return validateScientificStatements(request);
  }

  private async text(papers: ScientificSearchPaper[], plan: ScientificQueryPlan,
    request: ScientificSearchRequest, signal: AbortSignal): Promise<ChannelResult> {
    if (!papers.length) return {candidates: [], degradation: []};
    const ids = papers.map(p => p.generation.id), terms = scientificQueryTerms(plan.query), han = /\p{Script=Han}/u.test(plan.query);
    const rows = han ? this.repository.scientificIndex.lexicalHits(ids, terms, request.candidateLimit) :
      this.repository.scientificIndex.textHits(ids, terms.map(term => `"${term}"`).join(' OR '), request.candidateLimit);
    const project = (generationId: string, chunkId: string): Candidate => {
      const paper = papers.find(p => p.generation.id === generationId)!;
      const chunk = paper.chunks.find(c => c.id === chunkId);
      if (!chunk) throw new Error('research_scientific_search_chunk_missing');
      return scientificChunkCandidate(paper, chunk);
    };
    const lexical = rows.map((r, i) => ({...project(r.generationId, r.chunkId), score: 1 / (61 + i),
      signals: [{channel: 'text' as const, method: han ? 'lexical' as const : 'fts' as const, rank: i + 1, score: r.score}]}));
    const identity = this.embeddings.selectedIdentity(request.embeddingConfigId);
    if (identity === null) return {candidates: lexical, degradation: ['dense_not_configured']};
    const denseIds = papers.filter(p => hash(p.generation.snapshot.embedding) === hash(identity)).map(p => p.generation.id);
    const degradation: string[] = denseIds.length < papers.length ? ['dense_index_identity_mismatch'] : [];
    if (!denseIds.length) return {candidates: lexical, degradation};
    const vector = await this.embeddings.queryVector(plan.query, identity, signal);
    signal.throwIfAborted();
    if (hash(this.embeddings.selectedIdentity(request.embeddingConfigId)) !== hash(identity)) {
      throw new Error('research_embedding_config_changed');
    }
    if (vector.blob === null) return {candidates: lexical, degradation: [...degradation, vector.degradation!]};
    const dense = this.repository.scientificIndex.denseHits(denseIds, normalizeEmbeddingBlob(vector.blob, identity.dimensions),
      request.candidateLimit).map((r, i) => ({...project(r.generationId, r.chunkId), score: 1 / (61 + i),
        signals: [{channel: 'text' as const, method: 'dense' as const, rank: i + 1, score: r.score}]}));
    return {candidates: fuseScientificCandidates([lexical, dense], plan).slice(0, request.candidateLimit), degradation};
  }

  private metadata(papers: ScientificSearchPaper[], plan: ScientificQueryPlan, limit: number): ChannelResult {
    const terms = scientificQueryTerms(plan.query), rows: Array<{candidate: Candidate; score: number; exact: boolean}> = [];
    for (const p of papers) {
      const m = p.ir.metadata, exact = plan.scope.selection === 'selected' || Boolean(m.doi && plan.filters.dois.includes(normalizeResearchDoi(m.doi)));
      if (plan.filters.years.length && !plan.filters.years.includes(m.year!)) continue;
      if (plan.filters.dois.length && (!m.doi || !plan.filters.dois.includes(normalizeResearchDoi(m.doi)))) continue;
      const score = lexicalScore(JSON.stringify(m), terms);
      if (!exact && !score && !plan.filters.years.length) continue;
      rows.push({candidate: scientificMetadataCandidate(p), score, exact});
    }
    return {candidates: ranked(rows, 'metadata', 'lexical', limit), degradation: []};
  }

  private object(papers: ScientificSearchPaper[], plan: ScientificQueryPlan,
    channel: 'table' | 'equation' | 'figure', limit: number): ChannelResult {
    const numbers = plan.objects[channel === 'table' ? 'tableNumbers' : channel === 'figure' ? 'figureNumbers' : 'equationNumbers'];
    const terms = scientificQueryTerms(plan.query), rows: Array<{candidate: Candidate; score: number; exact: boolean}> = [];
    for (const paper of papers) for (const chunk of paper.chunks) {
      if (channel === 'table' ? !['table', 'table_row_group'].includes(chunk.chunkType) :
        chunk.chunkType !== channel) continue;
      if (chunk.chunkType === 'table' && paper.chunks.some(c => c.parentId === chunk.id && c.chunkType === 'table_row_group')) continue;
      const candidate = scientificChunkCandidate(paper, chunk), object = candidate.object;
      const number = object.kind === 'table' ? object.number : object.kind === 'equation' ? object.data.equationNumber :
        object.kind === 'figure' ? object.data.objectNumber : null;
      const exact = numbers.length > 0 && numbers.includes(numbered(number)!);
      if (numbers.length && !exact) continue;
      const refs = object.kind === 'figure' || object.kind === 'equation'
        ? object.data.references.map(r => r.evidence.text).join('\n') : '';
      const searchable = `${chunk.embeddingText}\n${refs}`;
      if (channel === 'table' && (plan.filters.metrics.length && !plan.filters.metrics.some(t => lexicalScore(searchable, [t])) ||
        plan.filters.datasets.length && !plan.filters.datasets.some(t => lexicalScore(searchable, [t])))) continue;
      const score = lexicalScore(searchable, terms);
      if (!exact && terms.length && !score) continue;
      rows.push({candidate, score, exact});
    }
    return {candidates: ranked(rows, channel, 'lexical', limit), degradation: []};
  }

  private citation(papers: ScientificSearchPaper[], plan: ScientificQueryPlan, limit: number,
    signal: AbortSignal): ChannelResult {
    if (plan.scope.projectId === null) return {candidates: [], degradation: ['citation_requires_project']};
    const rows: Array<{candidate: Candidate; score: number}> = [], degradation: string[] = [];
    for (const paper of papers) {
      signal.throwIfAborted();
      if (!paper.libraryItemId || rows.length >= limit) continue;
      const projectId = plan.scope.projectId, itemId = paper.libraryItemId;
      const snapshot = this.scholarly.history({projectId, itemId, offset: 0, limit: 1}).records[0];
      if (!snapshot) continue;
      for (const source of snapshot.sources) {
        if (source.status !== 'ok') {degradation.push(`citation_${source.source}_snapshot_failed`); continue;}
        for (let offset = 0; rows.length < limit;) {
          signal.throwIfAborted();
          const page = this.scholarly.read({projectId, itemId, snapshotId: snapshot.id, source: source.source, offset,
            limit: Math.min(100, limit - rows.length)});
          for (const relation of page.relations) {
            rows.push({score: 1, candidate: scientificCitationCandidate(paper, {kind: 'citation', snapshotId: snapshot.id,
              contentHash: snapshot.contentHash, queriedAt: snapshot.queriedAt, source: source.source, relation})});
          }
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
      }
    }
    return {candidates: ranked(rows, 'citation', 'snapshot', limit), degradation: [...new Set(degradation)]};
  }
}
