import {isDeepStrictEqual} from 'node:util';
import type {RocPluginContext} from '../../kernel/types';
import {mainResourceActivity, type ResourceActivity} from '../../services/resource-activity';
import {
  scientificExtractionConfigSchema, scientificExtractionSnapshotSchema, scientificKnowledgeReadSchema,
  type ScientificExtractionConfig, type ScientificExtractionJob, type ScientificExtractionJobRequest,
  type ScientificExtractionSnapshot, type ScientificKnowledgeRead, type ScientificKnowledgeReadRequest
} from '../../../shared/schemas/research-scientific-extraction';
import type {ResearchRepository} from './repository';
import {paperCardKnowledgeSchema, type PaperCardKnowledge,
  type PaperCardKnowledgeReadRequest} from '../../../shared/schemas/research-paper-card-knowledge';
import {ScientificSearchSnapshots, type ScientificSearchPaper} from './scientific-search-snapshot';
import {scientificExtractionInputHash, scientificResolutionHash} from './scientific-extraction-repository';
import {type ScientificExtractionSession, type ScientificExtractionSessionFactory} from './scientific-extraction-model';
import {runScientificExtraction} from './scientific-extraction-pipeline';
import {processingFailureCode, type ProcessingStage} from './processing-trace';
import {wikiPaperKnowledgeDigest, type WikiPaperKnowledgeState} from './wiki-paper-knowledge';
import {researchContentHash} from './research-files';
import {scientificKnowledgeSearchSchema, scientificKnowledgeSearchResultSchema,
  type ScientificKnowledgeSearchRequest, type ScientificKnowledgeSearchResult,
  type ScientificKnowledgeSearchHit} from '../../../shared/schemas/research-scientific-knowledge-search';

type DocumentRequest = {projectId: string; documentId: string};
type Session = {stamp: string; value: ScientificExtractionSession};
type Active = {job: ScientificExtractionJob; stamp: string; controller: AbortController; signal: AbortSignal};
const failure = (name: string): Error => new Error(`research_scientific_extraction_${name}`);
const stages: Record<'entities' | 'facts' | 'relations', ProcessingStage> = {
  entities: 'entity_extraction', facts: 'fact_extraction', relations: 'relation_extraction'
};

/** A single background owner captures authorized inputs, runs proposals and atomically publishes validated generations. */
export class ScientificExtractionService {
  private readonly snapshots: ScientificSearchSnapshots;
  private readonly controller = new AbortController();
  private cached: Session | null = null;
  private creating: {stamp: string; pending: Promise<Session>} | null = null;
  private readonly constructions = new Set<Promise<Session>>();
  private active: Active | null = null;
  private pending: Promise<void> | null = null;
  private dirty = false;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repository: ResearchRepository,
    roots: {library: string | null; index: string | null},
    private readonly createSession: ScientificExtractionSessionFactory,
    private readonly modelStamp: () => string,
    private readonly options: {
      pollMs?: number; timeoutMs?: number; logger?: Pick<RocPluginContext['logger'], 'warn'>;
      activity?: ResourceActivity;
    } = {}
  ) {this.snapshots = new ScientificSearchSnapshots(repository, roots);}

  start(): void {
    this.open();
    if (this.started) return;
    this.started = true;
    this.repository.scientificExtraction.recover();
    this.unsubscribe = this.repository.subscribeKnowledgeSources(() => this.wake());
    this.timer = setInterval(() => this.wake(), this.options.pollMs ?? 5000);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (!this.started || this.controller.signal.aborted) return;
    this.dirty = true;
    if (this.active) {
      try {this.fence(this.active);}
      catch (error) {this.active.controller.abort(error);}
    }
    if (this.pending) return;
    this.pending = Promise.resolve().then(() => this.drain()).catch(error => this.report(error)).finally(() => {
      this.pending = null;
      if (this.dirty) this.wake();
    });
  }

  async idle(): Promise<void> {while (this.pending) await this.pending;}

  async shutdown(): Promise<void> {
    if (!this.controller.signal.aborted) this.controller.abort(failure('interrupted'));
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dirty = false;
    this.active?.controller.abort(this.controller.signal.reason);
    await this.pending;
    // Model construction may be awaiting a credential read even without an active job.
    await Promise.allSettled(this.constructions);
    this.cached = null;
  }

  async enqueue(request: DocumentRequest, signal = new AbortController().signal): Promise<ScientificExtractionJob> {
    this.open();
    signal = AbortSignal.any([signal, this.controller.signal]);
    const {session, paper, snapshot} = await this.input(request, signal);
    this.assertStamp(session.stamp, signal);
    const job = this.repository.scientificExtraction.enqueue(snapshot, paper.ir);
    this.wake();
    return job;
  }

  async retry(request: ScientificExtractionJobRequest,
    signal = new AbortController().signal): Promise<ScientificExtractionJob> {
    this.open();
    signal = AbortSignal.any([signal, this.controller.signal]);
    const expected = this.expected(request);
    if (expected.status !== 'failed' && expected.status !== 'cancelled') throw failure('not_retryable');
    const {session, paper, snapshot} = await this.input(request, signal);
    this.assertStamp(session.stamp, signal);
    this.expected(request);
    const job = this.repository.scientificExtraction.enqueue(snapshot, paper.ir, true);
    this.wake();
    return job;
  }

  cancel(request: ScientificExtractionJobRequest): ScientificExtractionJob {
    this.open();
    const expected = this.expected(request);
    if (expected.status !== 'queued' && expected.status !== 'running') throw failure('not_cancellable');
    this.repository.scientificExtraction.fail(expected.id, request.projectId,
      'research_scientific_extraction_cancelled', true);
    if (this.active?.job.id === expected.id) this.active.controller.abort(failure('cancelled'));
    return this.repository.scientificExtraction.get(expected.id, request.projectId);
  }

  async read(request: ScientificKnowledgeReadRequest,
    signal = new AbortController().signal): Promise<ScientificKnowledgeRead> {
    this.open();
    this.repository.scientificExtraction.authorizeDocument(request.projectId, request.documentId);
    signal = AbortSignal.any([signal, this.controller.signal]);
    let session: Session | null = null, configurationError: string | null = null;
    try {session = await this.session(signal);}
    catch (error) {
      signal.throwIfAborted(); this.open();
      configurationError = processingFailureCode(error);
    }
    const paper = await this.capture(request, signal, false);
    const snapshot = paper && session ? this.snapshot(request.projectId, paper, session.value.config) : null;
    if (session) this.assertStamp(session.stamp, signal);
    else {signal.throwIfAborted(); this.open();}
    const result = this.repository.scientificExtraction.read(request.projectId, request.documentId,
      paper?.receipt.paperIR ?? null, request.generationId, paper?.ir,
      snapshot ? scientificExtractionInputHash(snapshot) : null);
    return scientificKnowledgeReadSchema.parse({...result, configurationError});
  }

  async search(input: ScientificKnowledgeSearchRequest,
    signal = new AbortController().signal): Promise<ScientificKnowledgeSearchResult> {
    const request = scientificKnowledgeSearchSchema.parse(input), store = this.repository.scientificExtraction;
    this.open(); signal = AbortSignal.any([signal, this.controller.signal]); signal.throwIfAborted();
    for (const documentId of request.documentIds) store.authorizeDocument(request.projectId, documentId);
    const {offset, limit, basisDigest: expectedDigest, ...selection} = request;
    const capture = () => {
      signal.throwIfAborted(); this.open();
      for (const documentId of request.documentIds) store.authorizeDocument(request.projectId, documentId);
      const generations = this.snapshots.catalog(request.projectId, []).filter(generation =>
        request.documentIds.length === 0 || request.documentIds.includes(generation.snapshot.paperIR.identity.documentId));
      const documentIds = request.documentIds.length ? request.documentIds :
        generations.map(generation => generation.snapshot.paperIR.identity.documentId);
      const jobs = store.searchSources(request.projectId, documentIds);
      return {documentIds, generations, jobs, digest: researchContentHash(JSON.stringify({selection, model: this.modelStamp(),
        generations: generations.map(generation => ({id: generation.id, snapshot: generation.snapshot})),
        jobs: jobs.map(job => ({id: job.id, inputHash: job.inputHash, resultHash: job.resultHash})),
        aliases: store.aliases(request.projectId)}))};
    };
    const basis = capture();
    if (expectedDigest !== null && expectedDigest !== basis.digest) throw new Error('research_scientific_search_basis_changed');
    const pointers = store.searchCandidates(request, basis.documentIds);
    const selected = pointers.slice(0, limit), reads = new Map<string, ScientificKnowledgeRead>();
    const readTargets = new Map<string, string | null>(selected.map(pointer => [pointer.documentId, pointer.generationId]));
    for (const documentId of request.documentIds) {
      if (!readTargets.has(documentId)) {
        readTargets.set(documentId, basis.jobs.find(job => job.snapshot.source.paperIR.identity.documentId === documentId)?.id ?? null);
      }
    }
    const guardFiles = await this.snapshots.guardFiles(request.projectId, basis.generations.filter(generation =>
      readTargets.has(generation.snapshot.paperIR.identity.documentId)), signal);
    const readSources = async (): Promise<void> => {
      for (const [documentId, generationId] of readTargets) {
        reads.set(documentId, await this.read({projectId: request.projectId, documentId, generationId}, signal));
      }
    };
    await readSources();
    // Re-read original bytes after all source reads have yielded, then fence membership/publication/configuration.
    reads.clear(); await readSources();
    guardFiles();
    if (capture().digest !== basis.digest) throw new Error('research_scientific_search_basis_changed');
    const hits: ScientificKnowledgeSearchHit[] = [], unavailable: ScientificKnowledgeSearchResult['unavailable'] = [];
    for (const [documentId, read] of reads) if (read.state !== 'current') {
      unavailable.push({documentId, state: read.state, configurationError: read.configurationError ?? null});
    }
    for (const pointer of selected) {
      const read = reads.get(pointer.documentId)!;
      if (read.state !== 'current') continue;
      if (read.publishedJob?.publication !== 'active' || read.publishedJob.id !== pointer.generationId || !read.knowledge) {
        throw new Error('research_scientific_search_basis_changed');
      }
      const source = {documentId: pointer.documentId, generationId: pointer.generationId}, exactMatch = !!pointer.exactMatch;
      const bundle = read.knowledge;
      const relatedEntities = (ids: Array<string | null>) => [...new Set(ids.filter(id => id !== null))]
        .map(id => {
          const entity = bundle.entities.find(item => item.id === id);
          if (!entity) throw failure('result_invalid');
          return entity;
        });
      if (request.kind === 'entity') {
        const value = bundle.entities.find(item => item.id === pointer.id && item.candidateId === pointer.candidateId);
        if (!value) throw failure('result_invalid');
        hits.push({kind: 'entity', source, exactMatch, value});
      } else if (request.kind === 'fact') {
        const value = bundle.facts.find(item => item.id === pointer.id);
        if (!value) throw failure('result_invalid');
        const ids = [value.subjectEntityId, value.objectEntityId, value.conditions.datasetId,
          value.conditions.metricId, value.conditions.baselineId];
        hits.push({kind: 'fact', source, exactMatch, value, entities: relatedEntities(ids)});
      } else {
        const value = bundle.relations.find(item => item.id === pointer.id);
        if (!value) throw failure('result_invalid');
        hits.push({kind: 'relation', source, exactMatch, value,
          entities: relatedEntities([value.fromEntityId, value.toEntityId])});
      }
    }
    return scientificKnowledgeSearchResultSchema.parse({projectId: request.projectId, kind: request.kind,
      basisDigest: basis.digest, hits, unavailable, nextOffset: pointers.length > limit ? offset + limit : null,
      scientificApproval: 'unreviewed'});
  }

  async readPaperCard(request: PaperCardKnowledgeReadRequest,
    signal = new AbortController().signal): Promise<PaperCardKnowledge> {
    signal = AbortSignal.any([signal, this.controller.signal]);
    const selected = await this.read(request, signal);
    if (!selected.publishedJob) return paperCardKnowledgeSchema.parse({...selected,
      version: 2, documentId: request.documentId, paperIR: null, objects: null, methodComponentIds: []});
    const job = selected.publishedJob;
    const ir = await this.snapshots.readExtractionIR(request.projectId, job.id, signal);
    // The history read yields. Capture current source/configuration again before returning current facts.
    const current = await this.read(request, signal);
    if (current.publishedJob?.id !== job.id) throw failure('generation_changed');
    return paperCardKnowledgeSchema.parse({...current, version: 2, documentId: request.documentId,
      paperIR: job.snapshot.source.paperIR,
      objects: {tables: ir.tables, figures: ir.figures, equations: ir.equations, algorithms: ir.algorithms},
      methodComponentIds: current.knowledge!.facts.filter(fact => fact.factType === 'method_component').map(fact => fact.id)});
  }

  /** Used inside Wiki CAS transactions; async consumers must separately read and verify original bytes. */
  wikiKnowledgeState(projectId: string, documentId: string): WikiPaperKnowledgeState {
    try {
      this.open();
      const store = this.repository.scientificExtraction;
      store.authorizeDocument(projectId, documentId);
      const active = store.active(projectId, documentId);
      if (!active) return {state: 'missing', generationId: null, digest: null};
      const generation = this.snapshots.catalog(projectId, []).find(g => g.snapshot.paperIR.identity.documentId === documentId);
      if (!generation) return {state: 'stale', generationId: active.id, digest: null};
      this.snapshots.assertOwner(projectId, generation);
      // The selected-model stamp and the handle-derived model revision are different identities.
      if (!this.cached || this.cached.stamp !== this.modelStamp()) {
        return {state: 'unavailable', generationId: active.id, digest: null};
      }
      const resolution = store.resolution(projectId);
      const expected = scientificExtractionInputHash({...active.snapshot,
        source: {...active.snapshot.source, paperIR: generation.snapshot.paperIR},
        config: this.cached.value.config, resolution, aliasesHash: scientificResolutionHash(resolution)});
      if (expected !== active.inputHash) return {state: 'stale', generationId: active.id, digest: null};
      store.bundle(active.id, projectId);
      return {state: 'current', generationId: active.id, digest: wikiPaperKnowledgeDigest(active)};
    } catch {
      // No unavailable owner, scope, configuration or corrupt publication can bless a current section.
      return {state: 'unavailable', generationId: null, digest: null};
    }
  }

  private open(): void {if (this.controller.signal.aborted) throw failure('closed');}
  private assertStamp(stamp: string, signal: AbortSignal): void {
    signal.throwIfAborted(); this.open();
    if (this.modelStamp() !== stamp) throw failure('configuration_changed');
  }

  private async session(signal: AbortSignal): Promise<Session> {
    signal.throwIfAborted(); this.open();
    const stamp = this.modelStamp();
    if (this.cached?.stamp === stamp) return this.cached;
    if (this.creating?.stamp !== stamp) {
      const pending = Promise.resolve().then(() => this.createSession()).then(value => {
        this.assertStamp(stamp, this.controller.signal);
        const session = {stamp, value: {...value, config: scientificExtractionConfigSchema.parse(value.config)}};
        this.cached = session;
        return session;
      });
      const creating = {stamp, pending};
      this.creating = creating;
      this.constructions.add(pending);
      void pending.finally(() => {
        this.constructions.delete(pending);
        if (this.creating === creating) this.creating = null;
      }).catch(() => {});
    }
    const pending = this.creating!.pending;
    const session = await new Promise<Session>((resolve, reject) => {
      const abort = () => {signal.removeEventListener('abort', abort); reject(signal.reason);};
      signal.addEventListener('abort', abort, {once: true});
      pending.then(value => {signal.removeEventListener('abort', abort); resolve(value);},
        error => {signal.removeEventListener('abort', abort); reject(error);});
      if (signal.aborted) abort();
    });
    this.assertStamp(stamp, signal);
    return session;
  }

  private expected(request: ScientificExtractionJobRequest): ScientificExtractionJob {
    const store = this.repository.scientificExtraction;
    store.authorizeDocument(request.projectId, request.documentId);
    const job = store.get(request.generationId, request.projectId);
    if (job.snapshot.source.paperIR.identity.documentId !== request.documentId ||
      store.latest(request.projectId, request.documentId)?.id !== job.id) throw failure('generation_changed');
    return job;
  }

  private async capture(request: DocumentRequest, signal: AbortSignal, required: true): Promise<ScientificSearchPaper>;
  private async capture(request: DocumentRequest, signal: AbortSignal, required: false): Promise<ScientificSearchPaper | null>;
  private async capture(request: DocumentRequest, signal: AbortSignal, required: boolean): Promise<ScientificSearchPaper | null> {
    signal.throwIfAborted(); this.open();
    this.repository.scientificExtraction.authorizeDocument(request.projectId, request.documentId);
    // catalog validates requested IDs but returns the whole catalog; capture exactly this document.
    let generations = this.snapshots.catalog(request.projectId, []).filter(g =>
      g.snapshot.paperIR.identity.documentId === request.documentId);
    if (generations.length === 0) {
      if (required) throw failure('source_missing');
      return null;
    }
    for (let attempt = 0; ; attempt++) {
      try {return (await this.snapshots.capture(request.projectId, generations, signal))[0]!;}
      catch (error) {
        signal.throwIfAborted(); this.open();
        const next = this.snapshots.catalog(request.projectId, []).filter(g =>
          g.snapshot.paperIR.identity.documentId === request.documentId);
        // Only an index replacement with the identical immutable IR may be recaptured.
        if (attempt >= 2 || !(error instanceof Error) || error.message !== 'research_scientific_search_source_changed' ||
          next.length !== 1 || !isDeepStrictEqual(next[0]!.snapshot.paperIR, generations[0]!.snapshot.paperIR)) throw error;
        generations = next;
      }
    }
  }

  private snapshot(projectId: string, paper: ScientificSearchPaper, config: ScientificExtractionConfig): ScientificExtractionSnapshot {
    const resolution = this.repository.scientificExtraction.resolution(projectId);
    return scientificExtractionSnapshotSchema.parse({projectId, source: paper.receipt, config, resolution,
      aliasesHash: scientificResolutionHash(resolution)});
  }

  private async input(request: DocumentRequest, signal: AbortSignal) {
    this.repository.scientificExtraction.authorizeDocument(request.projectId, request.documentId);
    const session = await this.session(signal), paper = await this.capture(request, signal, true);
    this.assertStamp(session.stamp, signal);
    return {session, paper, snapshot: this.snapshot(request.projectId, paper, session.value.config)};
  }

  private fence(active: Active): void {
    this.assertStamp(active.stamp, active.signal);
    const {job} = active, projectId = job.snapshot.projectId, documentId = job.snapshot.source.paperIR.identity.documentId;
    const current = this.expected({projectId, documentId, generationId: job.id});
    if (current.status !== 'running') throw failure('generation_changed');
    const generation = this.snapshots.catalog(projectId, []).find(g => g.snapshot.paperIR.identity.documentId === documentId);
    const aliasesHash = scientificResolutionHash(this.repository.scientificExtraction.resolution(projectId));
    if (!generation || !isDeepStrictEqual(generation.snapshot.paperIR, job.snapshot.source.paperIR) ||
      aliasesHash !== job.snapshot.aliasesHash) throw failure('input_changed');
  }

  private async current(active: Active, config: ScientificExtractionConfig) {
    this.fence(active);
    const {job} = active, projectId = job.snapshot.projectId, documentId = job.snapshot.source.paperIR.identity.documentId;
    const paper = await this.capture({projectId, documentId}, active.signal, true);
    this.fence(active);
    const snapshot = this.snapshot(projectId, paper, config);
    if (scientificExtractionInputHash(snapshot) !== job.inputHash) throw failure('input_changed');
    return {paper, snapshot};
  }

  private async scan(): Promise<void> {
    const projects = this.repository.listProjects().filter(project => project.status !== 'archived');
    let session: Session | null = null;
    for (const project of projects) {
      try {
        const generations = this.snapshots.catalog(project.id, []);
        if (generations.length === 0) continue;
        session ??= await this.session(this.controller.signal);
        for (const generation of generations) {
          if (this.controller.signal.aborted) return;
          const documentId = generation.snapshot.paperIR.identity.documentId;
          try {
            const latest = this.repository.scientificExtraction.latest(project.id, documentId);
            const resolution = this.repository.scientificExtraction.resolution(project.id);
            const aliasesHash = scientificResolutionHash(resolution);
            if (latest && scientificExtractionInputHash({...latest.snapshot,
              source: {...latest.snapshot.source, paperIR: generation.snapshot.paperIR}, config: session.value.config,
              resolution, aliasesHash}) === latest.inputHash) continue;
            const input = await this.input({projectId: project.id, documentId}, this.controller.signal);
            this.assertStamp(input.session.stamp, this.controller.signal);
            this.repository.scientificExtraction.enqueue(input.snapshot, input.paper.ir);
          } catch (error) {this.report(error, project.id, documentId);}
        }
      } catch (error) {this.report(error, project.id);}
    }
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.controller.signal.aborted) {
      this.dirty = false;
      this.repository.wiki.refreshPaperKnowledgeDependencies();
      await this.scan();
      this.repository.wiki.refreshPaperKnowledgeDependencies();
      for (const job of this.repository.scientificExtraction.queued()) {
        if (this.controller.signal.aborted) return;
        await this.process(job);
      }
    }
  }

  private async process(job: ScientificExtractionJob): Promise<void> {
    const projectId = job.snapshot.projectId, identity = job.snapshot.source.paperIR.identity;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.controller.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 600_000)]);
    const release = (this.options.activity ?? mainResourceActivity).begin('research');
    let active: Active | null = null;
    const trace = this.repository.processing.trace({trace_id: `extraction:${job.id}`, project_id: projectId,
      document_id: identity.documentId, paper_id: identity.paperId, source_hash: identity.sourceHash,
      parse_id: identity.parseId, parser_fingerprint: identity.parserFingerprint,
      paper_ir_version: job.snapshot.source.paperIR.version, index_generation: job.snapshot.source.generationId});
    try {
      const session = await this.session(signal);
      if (!isDeepStrictEqual(session.value.config, job.snapshot.config)) throw failure('configuration_changed');
      this.repository.scientificExtraction.claim(job.id, projectId);
      active = {job, stamp: session.stamp, controller, signal};
      this.active = active;
      const original = await this.current(active, session.value.config);
      const result = await trace.run('scientific_extraction', () => runScientificExtraction({
        session: session.value, snapshot: job.snapshot, generationId: job.id, ir: original.paper.ir, signal,
        assertCurrent: async () => {await this.current(active!, session.value.config);},
        observe: async (stage, _batch, operation) => {await trace.run(stages[stage], operation,
          {inputCount: 1, unit: 'model_calls'}, () => 1);}
      }), {unit: 'model_calls'}, value => value.calls);
      const current = await this.current(active, session.value.config);
      signal.throwIfAborted();
      trace.sync('extraction_publish', () => this.repository.scientificExtraction.publish(job.id, projectId,
        result.candidates, current.paper.ir, () => {
          signal.throwIfAborted(); this.fence(active!);
          return current.snapshot;
        }));
    } catch (error) {
      if (this.controller.signal.aborted) {
        // Leave durable running work recoverable instead of recording a user cancellation.
        this.report(error, projectId, identity.documentId);
      } else {
        const code = processingFailureCode(error);
        const cancelled = controller.signal.aborted || ['research_scientific_extraction_configuration_changed',
          'research_scientific_extraction_input_changed', 'research_scientific_extraction_generation_changed',
          'research_scientific_search_source_changed', 'research_scientific_extraction_scope_invalid'].includes(code);
        this.repository.scientificExtraction.fail(job.id, projectId, code, cancelled);
        if (cancelled && code !== 'research_scientific_extraction_cancelled') this.dirty = true;
      }
    } finally {
      if (this.active === active) this.active = null;
      release();
    }
  }

  private report(error: unknown, projectId?: string, documentId?: string): void {
    this.options.logger?.warn('Scientific extraction background boundary failed.',
      {failureCode: processingFailureCode(error), projectId, documentId});
  }
}
