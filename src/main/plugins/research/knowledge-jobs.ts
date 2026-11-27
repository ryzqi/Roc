import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {logWarn} from '../../services/errors';
import type {Database} from 'better-sqlite3';
import {knowledgeJobSchema, type KnowledgeJob} from '../../../shared/schemas/research-knowledge-jobs';
import type {ResearchEmbeddingReceipt} from './embedding-service';
import {mainResourceActivity, type ResourceActivity} from '../../services/resource-activity';

type ActiveJob = {controller: AbortController; settled: Promise<void>};
const maximumConcurrentJobs = 2;
const retryableProviderError = /^embedding_provider_(?:http_(?:429|502|503|504)|timeout)$/u;

type Processor = (documentId: string, signal: AbortSignal, requireCurrent: () => void) => Promise<ResearchEmbeddingReceipt>;

/** Transactional outbox: source owners enqueue in their index transaction, then wake after commit. */
export class ResearchKnowledgeJobs {
  private processor: Processor | null = null;
  private scheduled: Promise<void> | null = null;
  private readonly active = new Map<string, ActiveJob>();
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly db: Database, private readonly now: () => string,
    private readonly activity: ResourceActivity = mainResourceActivity) {}

  enqueue(documentId: string): void {
    this.db.prepare(`INSERT INTO research_knowledge_jobs(document_id,generation,status,attempts,error,updated_at)
      VALUES (?,?,'queued',0,NULL,?) ON CONFLICT(document_id) DO UPDATE SET
      generation=excluded.generation,status='queued',attempts=0,error=NULL,updated_at=excluded.updated_at`)
      .run(documentId, randomUUID(), this.now());
  }

  /** A source transaction already prepared these vectors; retain a job for future configuration rebuilds. */
  acceptPrepared(documentId: string, receipt: ResearchEmbeddingReceipt): void {
    this.db.prepare("UPDATE research_knowledge_jobs SET status=?,error=?,updated_at=? WHERE document_id=? AND status='queued'")
      .run(receipt === null ? 'blocked' : 'ready', receipt === null
        ? '未配置可用的嵌入模型，请在检索设置中配置后重试。' : null, this.now(), documentId);
  }

  list(projectId: string | null, offset = 0): KnowledgeJob[] {
    return this.db.prepare(`SELECT j.document_id AS documentId,j.generation,d.title,j.status,j.attempts,j.error,j.updated_at AS updatedAt
      FROM research_knowledge_jobs j JOIN research_knowledge_documents d ON d.id=j.document_id
      WHERE (? IS NULL OR d.project_id=? OR d.project_id IS NULL)
      ORDER BY CASE j.status WHEN 'failed' THEN 0 WHEN 'blocked' THEN 1 WHEN 'running' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
      j.updated_at DESC,j.document_id LIMIT 50 OFFSET ?`).all(projectId, projectId, offset).map(row=>knowledgeJobSchema.parse(row));
  }

  get(documentId: string): KnowledgeJob | null {
    const row = this.db.prepare(`SELECT j.document_id AS documentId,j.generation,d.title,j.status,j.attempts,j.error,j.updated_at AS updatedAt
      FROM research_knowledge_jobs j JOIN research_knowledge_documents d ON d.id=j.document_id WHERE j.document_id=?`)
      .get(documentId);
    return row === undefined ? null : knowledgeJobSchema.parse(row);
  }

  subscribeChanges(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  }

  retry(documentId: string, generation: string): void {
    const result = this.db.prepare(`UPDATE research_knowledge_jobs SET status='queued',error=NULL,updated_at=?
      WHERE document_id=? AND generation=? AND status IN ('failed','blocked')`).run(this.now(), documentId, generation);
    if (result.changes !== 1) throw new Error('research_knowledge_job_changed');
    this.wake();
  }

  start(processor: Processor): void {
    this.processor = processor;
    this.db.prepare("UPDATE research_knowledge_jobs SET status='queued',error=NULL WHERE status='running'").run();
    this.wake();
  }

  configurationChanged(): void {
    // A changed provider/revision requires fresh receipts, including previously completed jobs.
    this.db.prepare("UPDATE research_knowledge_jobs SET generation=lower(hex(randomblob(16))),status='queued',attempts=0,error=NULL,updated_at=?").run(this.now());
    this.wake();
  }

  wake(): void {
    for (const listener of this.listeners) listener();
    this.schedule();
  }

  private schedule(): void {
    if (this.processor === null || this.scheduled !== null || this.controller.signal.aborted) return;
    // Never run external work inside the source owner's synchronous transaction.
    this.scheduled = Promise.resolve().then(() => {
      this.scheduled = null;
      this.fill();
    }).catch(() => logWarn('research_knowledge_job_schedule_failed'));
  }

  async releaseSources(documentIds: readonly string[]): Promise<void> {
    const matches = documentIds.flatMap(id => {
      const current = this.active.get(id);
      if (!current) return [];
      current.controller.abort();
      return [current.settled];
    });
    await Promise.all(matches);
  }

  async idle(): Promise<void> {
    while (this.scheduled !== null || this.active.size > 0) {
      await Promise.all([this.scheduled, ...Array.from(this.active.values(), job => job.settled)]);
    }
  }

  async shutdown(): Promise<void> {this.controller.abort(); await this.idle();}

  private fill(): void {
    const processor = this.processor;
    if (processor === null || this.controller.signal.aborted) return;
    while (this.active.size < maximumConcurrentJobs) {
      const job = this.db.prepare(`SELECT document_id,generation FROM research_knowledge_jobs WHERE status='queued'
        AND document_id NOT IN (SELECT value FROM json_each(?)) ORDER BY updated_at,document_id LIMIT 1`)
        .get(JSON.stringify([...this.active.keys()])) as {document_id: string; generation: string} | undefined;
      if (job === undefined) return;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.controller.signal]);
      const settled = this.process(job, processor, signal).catch(() => logWarn('research_knowledge_job_worker_failed')).finally(() => {
        this.active.delete(job.document_id);
        this.schedule();
      });
      this.active.set(job.document_id, {controller, settled});
    }
  }

  private async process(job: {document_id: string; generation: string}, processor: Processor, signal: AbortSignal): Promise<void> {
    const release = this.activity.begin('research');
    try {
      const begin = this.db.prepare(`UPDATE research_knowledge_jobs SET status='running',attempts=attempts+1,updated_at=?
        WHERE document_id=? AND generation=? AND status='queued'`);
      if (begin.run(this.now(), job.document_id, job.generation).changes !== 1) return;
      const requireCurrent = (): void => {
        const current = this.db.prepare('SELECT generation,status FROM research_knowledge_jobs WHERE document_id=?')
          .get(job.document_id) as {generation: string; status: string} | undefined;
        if (signal.aborted || current?.generation !== job.generation || current.status !== 'running') {
          throw new Error('research_knowledge_job_changed');
        }
      };
      let status: KnowledgeJob['status'] = 'ready';
      let error: string | null = null;
      try {
        let receipt: ResearchEmbeddingReceipt;
        for (let attempt = 0;; attempt++) {
          requireCurrent();
          try {
            receipt = await processor(job.document_id, signal, requireCurrent);
            break;
          } catch (failure) {
            if (attempt >= 2 || !(failure instanceof Error) || !retryableProviderError.test(failure.message)) throw failure;
            await delay(1000 * 2 ** attempt, undefined, {signal});
            this.db.prepare(`UPDATE research_knowledge_jobs SET attempts=attempts+1
              WHERE document_id=? AND generation=? AND status='running'`).run(job.document_id, job.generation);
          }
        }
        if (receipt === null) {
          status = 'blocked';
          error = '未配置可用的嵌入模型，请在检索设置中配置后重试。';
        }
      } catch {
        status = 'failed';
        error = '向量索引失败，请检查嵌入模型配置与网络后重试。';
      }
      if (this.controller.signal.aborted) {status = 'queued'; error = null;}
      // Replaced/deleted sources cannot be resurrected or marked ready by an old worker.
      this.db.prepare('UPDATE research_knowledge_jobs SET status=?,error=?,updated_at=? WHERE document_id=? AND generation=?')
        .run(status, error, this.now(), job.document_id, job.generation);
      for (const listener of this.listeners) listener();
    } finally {release();}
  }
}
