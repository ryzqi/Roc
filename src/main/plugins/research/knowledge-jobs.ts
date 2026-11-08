import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {knowledgeJobSchema, type KnowledgeJob} from '../../../shared/schemas/research-knowledge-jobs';
import type {ResearchEmbeddingReceipt} from './embedding-service';

type Processor = (documentId: string, signal: AbortSignal) => Promise<ResearchEmbeddingReceipt>;

/** Transactional outbox: source owners enqueue in their index transaction, then wake after commit. */
export class ResearchKnowledgeJobs {
  private processor: Processor | null = null;
  private running: Promise<void> | null = null;
  private readonly controller = new AbortController();
  constructor(private readonly db: Database, private readonly now: () => string) {}

  enqueue(documentId: string): void {
    this.db.prepare(`INSERT INTO research_knowledge_jobs(document_id,generation,status,attempts,error,updated_at)
      VALUES (?,?,'queued',0,NULL,?) ON CONFLICT(document_id) DO UPDATE SET
      generation=excluded.generation,status='queued',attempts=0,error=NULL,updated_at=excluded.updated_at`)
      .run(documentId, randomUUID(), this.now());
  }

  list(projectId: string | null, offset = 0): KnowledgeJob[] {
    return this.db.prepare(`SELECT j.document_id AS documentId,j.generation,d.title,j.status,j.attempts,j.error,j.updated_at AS updatedAt
      FROM research_knowledge_jobs j JOIN research_knowledge_documents d ON d.id=j.document_id
      WHERE (? IS NULL OR d.project_id=? OR d.project_id IS NULL)
      ORDER BY CASE j.status WHEN 'failed' THEN 0 WHEN 'blocked' THEN 1 WHEN 'running' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
      j.updated_at DESC,j.document_id LIMIT 50 OFFSET ?`).all(projectId, projectId, offset).map(row=>knowledgeJobSchema.parse(row));
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
    this.db.prepare("UPDATE research_knowledge_jobs SET generation=lower(hex(randomblob(16))),status='queued',error=NULL,updated_at=?").run(this.now());
    this.wake();
  }

  wake(): void {
    if (this.processor === null || this.running !== null || this.controller.signal.aborted) return;
    // Never run external work inside the source owner's synchronous transaction.
    this.running = Promise.resolve().then(()=>this.drain()).finally(()=>{this.running=null;});
  }

  async idle(): Promise<void> { await this.running; }
  async shutdown(): Promise<void> { this.controller.abort(); await this.running; }

  private async drain(): Promise<void> {
    while (!this.controller.signal.aborted && this.processor !== null) {
      const job = this.db.prepare("SELECT document_id,generation FROM research_knowledge_jobs WHERE status='queued' ORDER BY updated_at,document_id LIMIT 1")
        .get() as {document_id: string; generation: string} | undefined;
      if (job === undefined) return;
      this.db.prepare("UPDATE research_knowledge_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE document_id=? AND generation=?")
        .run(this.now(), job.document_id, job.generation);
      let status: KnowledgeJob['status'] = 'ready', error: string | null = null;
      try {
        if (await this.processor(job.document_id, this.controller.signal) === null) {
          status='blocked'; error='未配置可用的嵌入模型，请在检索设置中配置后重试。';
        }
      } catch {
        // Provider errors can contain private payloads; persist only a safe actionable message.
        status='failed'; error='向量索引失败，请检查嵌入模型配置与网络后重试。';
      }
      if (this.controller.signal.aborted) {status='queued'; error=null;}
      // Replaced/deleted sources cannot be resurrected or marked ready by an old worker.
      this.db.prepare('UPDATE research_knowledge_jobs SET status=?,error=?,updated_at=? WHERE document_id=? AND generation=?')
        .run(status, error, this.now(), job.document_id, job.generation);
    }
  }
}
