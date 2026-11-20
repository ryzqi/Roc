import type {AcquisitionOutcome, LiteratureAcquisitionRepository} from './literature-acquisition-repository';
import type {AcquisitionStep} from './literature-acquisition-service';
import type {ResearchLiteratureAcquisitionWiki} from './literature-acquisition-wiki';
import type {ResearchRepository} from './repository';

type Wiki = Pick<ResearchLiteratureAcquisitionWiki, 'ensureSource' | 'readSource' | 'retrySource' | 'reconcileBatch'>;

/** Wiki retries consume existing immutable parse/index receipts, never the network PDF stages. */
export class LiteratureWikiAcquisition {
  constructor(private readonly wiki: Wiki,
    private readonly acquisitions: Pick<LiteratureAcquisitionRepository, 'wikiBatches'>,
    private readonly now: () => number = Date.now) {}

  readonly process: AcquisitionStep = async (job, signal, requireCurrent): Promise<AcquisitionOutcome> => {
    signal.throwIfAborted(); requireCurrent();
    if (job.documentId === null) return {stage: 'import', status: 'queued', documentId: null};
    let source = this.wiki.ensureSource(job.projectId, job.documentId);
    signal.throwIfAborted(); requireCurrent();
    if (source.status === 'failed' || source.status === 'stale') {
      if (job.attempts > 0 || !source.error?.retryable) return this.failed(source.error?.code ?? 'wiki_source_failed');
      source = this.wiki.retrySource(job.projectId, job.documentId);
      return this.pending('research_literature_wiki_retrying');
    }
    // Register pending candidates as dependencies so later publication updates the same topic.
    let topicPending = false;
    if (job.projectId !== null) {
      for (const batch of this.acquisitions.wikiBatches(job)) {
        signal.throwIfAborted(); requireCurrent();
        const topic = this.wiki.reconcileBatch({projectId: job.projectId, batchId: batch.operationId,
          title: batch.title, total: batch.total, readyDocumentIds: batch.documentIds});
        if (topic.status === 'failed' || topic.status === 'blocked') return this.failed(topic.error?.code ?? 'wiki_topic_failed');
        if (!topic.ready && topic.error?.retryable === false) return {stage: 'wiki', status: 'blocked', errorCode: `research_${topic.error.code}`};
        // A partial topic is usable; its persisted coverage still reports every missing paper.
        if (!topic.ready && source.ready) topicPending = true;
      }
    }
    signal.throwIfAborted(); requireCurrent();
    if (!source.ready || topicPending) return this.pending();
    return {stage: 'wiki', status: 'ready', documentId: job.documentId};
  };

  private pending(errorCode?: string): AcquisitionOutcome {
    return {stage: 'wiki', status: 'queued', nextRetryAt: new Date(this.now() + 1000).toISOString(),
      ...(errorCode ? {errorCode} : {})};
  }

  private failed(code: string): AcquisitionOutcome {
    return {stage: 'wiki', status: 'failed', errorCode: `research_${code}`};
  }
}

/** A completed ledger row is not authority after a reparse, model change or Wiki edit. */
export function reconcileAcquisitionReadiness(acquisitions: LiteratureAcquisitionRepository,
  research: ResearchRepository, wiki: ResearchLiteratureAcquisitionWiki): void {
  const selected = research.knowledge.listEmbeddingConfigRows().find(row => row.enabled === 1);
  for (const job of acquisitions.completed()) {
    let indexed = false;
    try {
      const document = job.documentId === null ? null : research.documents.get(job.documentId);
      if (selected && document?.status === 'ready' && document.currentParseId && document.sourceHash === job.receipt?.sha256) {
        const knowledgeId = `document:${document.currentParseId}`;
        const generation = research.scientificIndex.active(null, document.id), embedding = generation?.snapshot.embedding;
        indexed = research.knowledgeJobs.get(knowledgeId)?.status === 'ready' &&
          !!generation && generation.snapshot.paperIR.identity.parseId === document.currentParseId &&
          !!embedding && embedding.configId === selected.id && embedding.revision === selected.revision &&
          embedding.model === selected.model && embedding.dimensions === selected.dimensions &&
          research.knowledge.hasDocumentEmbeddings(knowledgeId, selected.id, selected.revision);
        if (indexed) research.scientificIndex.verify(generation!.id);
      }
    } catch {indexed = false;}
    if (!indexed) {acquisitions.invalidate(job, 'index'); continue;}
    try {
      if (!wiki.readSource(job.projectId, job.documentId!).ready || acquisitions.wikiBatches(job).some(batch => {
        const topic = wiki.readBatch(job.projectId, batch.operationId);
        return !topic?.ready || topic.coverage.total !== batch.total ||
          batch.documentIds.some(id => !topic.sources.some(source => source.documentId === id));
      })) acquisitions.invalidate(job, 'wiki');
    } catch {acquisitions.invalidate(job, 'wiki');}
  }
}
