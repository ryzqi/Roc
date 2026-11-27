import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {paperAcquisitionJobSchema, type ListPaperAcquisition, type ListPaperAcquisitionResult,
  type PaperAcquisitionJob, type PaperAcquisitionReceipt, type PaperAcquisitionStage, type PaperAcquisitionStatus} from '../../../shared/schemas/literature-acquisition';
import type {LiteratureExecutionContext} from '../../services/literature-context';

const jobs = 'research_paper_acquisition_jobs';
const members = 'research_paper_acquisition_members';
const receipts = 'research_paper_download_receipts';
const projection = `j.id,j.project_id AS projectId,j.library_item_id AS libraryItemId,j.generation,j.stage,j.status,j.attempts,
  j.next_retry_at AS nextRetryAt,j.document_id AS documentId,j.error_code AS errorCode,j.updated_at AS updatedAt,
  json_extract(l.metadata_json,'$.title') AS title, json_extract(j.source_json,'$.lastFailure') AS failureJson,
  CASE WHEN r.id IS NULL THEN NULL ELSE json_object('id',r.id,'generation',r.generation,'sha256',r.sha256,'bytes',r.bytes,
    'sourceUrl',r.source_url,'provider',r.provider,'version',r.version,'license',r.license,'doi',r.doi,'arxivId',r.arxiv_id,
    'relativePath',r.relative_path,'acquiredAt',r.acquired_at) END AS receipt`;
const from = `FROM ${jobs} j JOIN research_library l ON l.id=j.library_item_id LEFT JOIN ${receipts} r ON r.id=j.receipt_id`;
const eligible = `l.archived=0 AND (j.project_id IS NULL OR (
  EXISTS (SELECT 1 FROM research_projects p WHERE p.id=j.project_id AND p.status!='archived') AND
  EXISTS (SELECT 1 FROM research_library_projects lp WHERE lp.item_id=j.library_item_id AND lp.project_id=j.project_id)))`;
const read = (row: unknown): PaperAcquisitionJob => {
  const {failureJson, ...raw} = row as {receipt: string | null; failureJson: string | null};
  return paperAcquisitionJobSchema.parse({...raw, receipt: raw.receipt === null ? null : JSON.parse(raw.receipt),
    ...(failureJson == null ? {} : {lastFailure: JSON.parse(failureJson)})});
};

type RadarPdfHints = {arxivId: string | null; coolPapersPdfUrl: string | null};
export type AcquisitionClaim = PaperAcquisitionJob & {source: unknown; radarPdfHints?: RadarPdfHints};
export type AcquisitionOutcome = {
  stage?: PaperAcquisitionStage;
  status: Exclude<PaperAcquisitionStatus, 'running'>;
  errorCode?: string;
  nextRetryAt?: string;
  source?: unknown;
  documentId?: string | null;
  receipt?: Omit<PaperAcquisitionReceipt, 'id' | 'generation' | 'acquiredAt'> | null;
};

export class LiteratureAcquisitionRepository {
  constructor(private readonly db: Database, readonly now: () => string = () => new Date().toISOString()) {}

  /** The caller commits library metadata, membership and its operation result together. */
  enqueue(projectId: string | null, libraryItemId: string, operationId?: string): boolean {
    if (!this.db.inTransaction) throw new Error('literature_acquisition_transaction_required');
    const instant = this.now();
    const job = this.db.prepare(`INSERT INTO ${jobs}(id,project_id,library_item_id,generation,stage,status,created_at,updated_at)
      VALUES (?,?,?,?,'resolve','queued',?,?) ON CONFLICT(COALESCE(project_id,''),library_item_id) DO UPDATE SET
      generation=CASE WHEN status IN ('failed','unavailable','cancelled') THEN excluded.generation ELSE generation END,
      attempts=CASE WHEN status IN ('failed','unavailable','cancelled') THEN 0 ELSE attempts END,
      error_code=CASE WHEN status IN ('failed','unavailable','cancelled') THEN NULL ELSE error_code END,
      next_retry_at=CASE WHEN status IN ('failed','unavailable','cancelled') THEN NULL ELSE next_retry_at END,
      updated_at=CASE WHEN status IN ('failed','unavailable','cancelled') THEN excluded.updated_at ELSE updated_at END,
      status=CASE WHEN status IN ('failed','unavailable','cancelled') THEN 'queued' ELSE status END
      RETURNING id,status`).get(`acq_${randomUUID()}`, projectId, libraryItemId, randomUUID(), instant, instant) as {id: string; status: PaperAcquisitionStatus};
    const joined = operationId === undefined || this.db.prepare(`INSERT OR IGNORE INTO ${members}(operation_id,job_id) VALUES (?,?)`)
      .run(operationId, job.id).changes === 1;
    return joined && ['queued', 'running'].includes(job.status);
  }

  /** Repair earlier Radar imports only where the project association still exists. */
  enqueueMissingRadarImports(): void {
    this.db.transaction(() => {
      const missing = this.db.prepare(`SELECT DISTINCT lp.project_id AS projectId,lp.item_id AS itemId
        FROM research_radar_articles a JOIN research_library_projects lp
          ON lp.project_id=a.project_id AND lp.item_id=json_extract(a.snapshot_json,'$.importedItemId')
        JOIN research_projects p ON p.id=lp.project_id AND p.status!='archived'
        JOIN research_library l ON l.id=lp.item_id AND l.archived=0
        WHERE NOT EXISTS (SELECT 1 FROM ${jobs} j WHERE j.project_id=lp.project_id AND j.library_item_id=lp.item_id)`)
        .all() as Array<{projectId: string; itemId: string}>;
      for (const {projectId, itemId} of missing) this.enqueue(projectId, itemId);
    })();
  }

  list(scope: LiteratureExecutionContext, request: ListPaperAcquisition): ListPaperAcquisitionResult {
    const [filter, args] = this.filter(scope, request.destination, request.operationId);
    const where = `${filter} AND (? IS NULL OR j.library_item_id=?)`;
    const parameters = [...args, request.libraryItemId ?? null, request.libraryItemId ?? null];
    const total = this.db.prepare(`SELECT COUNT(*) ${from} WHERE ${where}`).pluck().get(...parameters) as number;
    const rows = this.db.prepare(`SELECT ${projection} ${from} WHERE ${where} ORDER BY j.updated_at DESC,j.id LIMIT ? OFFSET ?`)
      .all(...parameters, request.limit, request.offset);
    return {jobs: rows.map(read), total, nextOffset: request.offset + request.limit < total ? request.offset + request.limit : null};
  }

  getScoped(scope: LiteratureExecutionContext, destination: ListPaperAcquisition['destination'], id: string): PaperAcquisitionJob {
    const [filter, args] = this.filter(scope, destination);
    const row = this.db.prepare(`SELECT ${projection} ${from} WHERE ${filter} AND j.id=?`).get(...args, id);
    if (row === undefined) throw new Error('literature_acquisition_not_found');
    return read(row);
  }

  change(job: PaperAcquisitionJob, generation: string, action: 'retry' | 'cancel', replacementDocumentId?: string): void {
    if (job.generation !== generation) throw new Error('literature_acquisition_changed');
    if (replacementDocumentId !== undefined) {
      if (action !== 'retry' || this.db.prepare(`SELECT 1 FROM research_documents d JOIN research_library l ON l.id=d.library_item_id
        WHERE d.id=? AND d.library_item_id=? AND d.media_type='application/pdf' AND l.archived=0
        AND (? IS NULL OR EXISTS (SELECT 1 FROM research_library_projects lp JOIN research_projects p ON p.id=lp.project_id
          WHERE lp.item_id=l.id AND lp.project_id=? AND p.status!='archived'))`)
        .get(replacementDocumentId, job.libraryItemId, job.projectId, job.projectId) === undefined) {
        throw new Error('literature_acquisition_replacement_invalid');
      }
    }
    if (action === 'cancel' && ['ready', 'cancelled'].includes(job.status)) return;
    const result = action === 'cancel' ? this.db.prepare(`UPDATE ${jobs} SET status='cancelled',next_retry_at=NULL,error_code=NULL,updated_at=?
      WHERE id=? AND generation=?`).run(this.now(), job.id, generation)
      : this.db.prepare(`UPDATE ${jobs} SET status='queued',generation=?,attempts=0,next_retry_at=NULL,error_code=NULL,updated_at=?,
        stage=CASE WHEN ? IS NOT NULL OR stage IN ('resolve','download') THEN 'resolve' ELSE stage END,
        document_id=COALESCE(?,document_id),source_json=CASE WHEN ? IS NOT NULL THEN NULL ELSE source_json END
        WHERE id=? AND generation=? AND status IN ('failed','blocked','unavailable','cancelled')`)
        .run(randomUUID(), this.now(), replacementDocumentId ?? null, replacementDocumentId ?? null,
          replacementDocumentId ?? null, job.id, generation);
    if (result.changes !== 1) throw new Error('literature_acquisition_changed');
  }

  recover(): void {
    this.db.prepare(`UPDATE ${jobs} SET status='queued',next_retry_at=NULL WHERE status='running'`).run();
  }

  /** Re-enable only work that was waiting for the document pipeline to be wired. */
  resumeBlockedImports(): number {
    return this.db.prepare(`UPDATE ${jobs} SET status='queued',next_retry_at=NULL,error_code=NULL,updated_at=?
      WHERE stage='import' AND status='blocked' AND error_code='research_document_import_not_configured'`)
      .run(this.now()).changes;
  }

  /** Resume index polling after the downstream knowledge worker or its configuration advances. */
  resumeBlockedIndexes(): number {
    return this.db.prepare(`UPDATE ${jobs} SET status='queued',next_retry_at=NULL,error_code=NULL,updated_at=?
      WHERE stage='index' AND status='blocked' AND error_code='research_fulltext_index_blocked' AND EXISTS (
        SELECT 1 FROM research_documents d JOIN research_knowledge_jobs k ON k.document_id='document:' || d.current_parse_id
        WHERE d.id=${jobs}.document_id AND k.status IN ('queued','running','ready'))`)
      .run(this.now()).changes;
  }

  /** Membership is committed by the metadata owner, never supplied by the model. */
  wikiBatches(job: Pick<PaperAcquisitionJob, 'id' | 'projectId'>): Array<{
    operationId: string; title: string; total: number; documentIds: string[];
  }> {
    if (job.projectId === null) return [];
    const operations = this.db.prepare(`SELECT i.id AS operationId,i.result_json AS result
      FROM ${members} m JOIN research_literature_imports i ON i.id=m.operation_id
      WHERE m.job_id=? AND json_extract(i.result_json,'$.destinationProjectId')=? ORDER BY i.id`)
      .all(job.id, job.projectId) as Array<{operationId: string; result: string}>;
    return operations.map(operation => {
      const result = JSON.parse(operation.result) as {topicTitle?: string; requestedCount: number};
      const rows = this.db.prepare(`SELECT DISTINCT j.document_id AS documentId ${from}
        JOIN ${members} m ON m.job_id=j.id WHERE m.operation_id=? AND j.project_id=? AND ${eligible}
        AND j.stage='wiki' AND j.status!='cancelled' AND j.document_id IS NOT NULL ORDER BY j.document_id`)
        .all(operation.operationId, job.projectId) as Array<{documentId: string}>;
      return {operationId: operation.operationId, title: result.topicTitle ?? '文献导入 · 原文对照',
        total: result.requestedCount, documentIds: rows.map(row => row.documentId)};
    });
  }

  completed(): PaperAcquisitionJob[] {
    return this.db.prepare(`SELECT ${projection} ${from} WHERE j.status='ready' AND ${eligible}`).all().map(read);
  }

  /** Invalidate only completed receipts; never revive cancelled work or reset active generations. */
  invalidate(job: PaperAcquisitionJob, stage: 'index' | 'wiki'): void {
    this.db.prepare(`UPDATE ${jobs} SET stage=?,status='queued',attempts=0,next_retry_at=NULL,error_code=NULL,updated_at=?
      WHERE id=? AND generation=? AND status='ready'`).run(stage, this.now(), job.id, job.generation);
  }

  resumeBlockedWiki(): void {
    this.db.prepare(`UPDATE ${jobs} SET status='queued',error_code=NULL,next_retry_at=NULL WHERE stage='wiki'
      AND status='blocked' AND error_code='research_literature_wiki_pipeline_not_configured'`).run();
  }

  claim(): AcquisitionClaim | null {
    return this.db.transaction(() => {
      const instant = this.now();
      const row = this.db.prepare(`SELECT ${projection},j.source_json AS source ${from} WHERE ${eligible} AND j.status='queued'
        AND (j.next_retry_at IS NULL OR j.next_retry_at<=?) ORDER BY j.updated_at,j.id LIMIT 1`).get(instant) as
        {id: string; generation: string; source: string | null} | undefined;
      if (row === undefined) return null;
      const {source, ...job} = row;
      const value = read(job);
      const radarPdfHints = value.stage === 'resolve' && value.projectId !== null
        ? this.radarPdfHints(value.projectId, value.libraryItemId) : undefined;
      this.db.prepare(`UPDATE ${jobs} SET status='running',next_retry_at=NULL,updated_at=? WHERE id=? AND generation=?`)
        .run(instant, row.id, row.generation);
      return {...value, status: 'running' as const, nextRetryAt: null, updatedAt: instant,
        source: source === null ? null : JSON.parse(source), ...(radarPdfHints === undefined ? {} : {radarPdfHints})};
    })();
  }

  private radarPdfHints(projectId: string, itemId: string): RadarPdfHints | undefined {
    return this.db.prepare(`SELECT json_extract(snapshot_json,'$.arxivId') AS arxivId,
      CASE WHEN feed_id='cool:' || project_id THEN json_extract(snapshot_json,'$.pdfUrl') ELSE NULL END AS coolPapersPdfUrl
      FROM research_radar_articles WHERE project_id=? AND json_extract(snapshot_json,'$.importedItemId')=?
      AND (json_type(snapshot_json,'$.arxivId')='text' OR (feed_id='cool:' || project_id AND json_type(snapshot_json,'$.pdfUrl')='text'))
      ORDER BY (arxivId IS NOT NULL) DESC,id LIMIT 1`).get(projectId, itemId) as RadarPdfHints | undefined;
  }

  nextRetryAt(): string | null {
    return this.db.prepare(`SELECT MIN(COALESCE(j.next_retry_at,'')) ${from} WHERE j.status='queued' AND ${eligible}`).pluck().get() as string | null;
  }

  requireCurrent(job: AcquisitionClaim): void {
    if (this.db.prepare(`SELECT 1 ${from} WHERE j.id=? AND j.generation=? AND j.status='running' AND ${eligible}`)
      .get(job.id, job.generation) === undefined) throw new Error('literature_acquisition_changed');
  }

  complete(job: AcquisitionClaim, outcome: AcquisitionOutcome): boolean {
    return this.db.transaction(() => {
      if (this.db.prepare(`SELECT 1 FROM ${jobs} WHERE id=? AND generation=? AND status='running'`).get(job.id, job.generation) === undefined) return false;
      const instant = this.now();
      const stage = outcome.stage ?? job.stage;
      const advancement = stage !== job.stage || outcome.status === 'ready';
      let receiptId = job.receipt?.id ?? null;
      if (outcome.receipt === null) receiptId = null;
      else if (outcome.receipt !== undefined) {
        const value = outcome.receipt;
        receiptId = `pdf_${randomUUID()}`;
        this.db.prepare(`INSERT INTO ${receipts}(id,job_id,generation,sha256,bytes,source_url,provider,version,license,doi,arxiv_id,relative_path,acquired_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(receiptId, job.id, job.generation, value.sha256, value.bytes, value.sourceUrl,
          value.provider, value.version, value.license, value.doi, value.arxivId, value.relativePath, instant);
      }
      this.db.prepare(`UPDATE ${jobs} SET stage=?,status=?,attempts=?,next_retry_at=?,document_id=?,receipt_id=?,source_json=?,error_code=?,updated_at=? WHERE id=?`)
        .run(stage, outcome.status, advancement ? 0 : job.attempts + (outcome.errorCode === undefined ? 0 : 1), outcome.nextRetryAt ?? null,
          outcome.documentId === undefined ? job.documentId : outcome.documentId, receiptId, JSON.stringify(outcome.source === undefined ? job.source : outcome.source),
          outcome.errorCode ?? null, instant, job.id);
      return true;
    })();
  }

  private filter(scope: LiteratureExecutionContext, destination: ListPaperAcquisition['destination'], operationId?: string): [string, (string | null)[]] {
    const global = destination === 'library_only' || scope.projectId === null;
    const args: (string | null)[] = [global ? null : scope.projectId];
    let filter = `j.project_id IS ? AND ${eligible}`;
    // Global library work launched in a project stays private to its authorized caller in that context.
    if (global && scope.projectId !== null) {
      filter += ` AND EXISTS (SELECT 1 FROM ${members} m JOIN research_literature_imports i ON i.id=m.operation_id
        WHERE m.job_id=j.id AND i.scope_project=? AND i.owner=?)`;
      args.push(scope.projectId, scope.owner);
    }
    if (operationId !== undefined) {
      filter += ` AND EXISTS (SELECT 1 FROM ${members} m WHERE m.job_id=j.id AND m.operation_id=?)`;
      args.push(operationId);
    }
    return [filter, args];
  }
}
