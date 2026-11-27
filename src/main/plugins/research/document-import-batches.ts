import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {basename, extname, relative} from 'node:path';
import type {Database} from 'better-sqlite3';
import type {DocumentImportBatch, DocumentImportBatchRef, DocumentImportBatchStart} from '../../../shared/schemas/research-document-import-batch';
import {logWarn} from '../../services/errors';
import {documentImportLocation, documentImportStamp, receiveDocumentImport} from './document-import-source';
import type {ResearchDocumentService} from './document-service';
import {researchContentHash, researchRelativePath} from './research-files';
import {verifyDocumentSource} from './verified-document-source';
import type {ResearchRepository} from './repository';

type EntryStatus = DocumentImportBatch['entries'][number]['status'];
type QueueStage = 'queued' | 'saved' | 'waiting_parse';
type Entry = {
  id: string; filename: string; source_path: string | null; source_stamp: string | null;
  source_hash: string | null; size: number | null; document_id: string | null; attempts: number;
  project_id: string | null; target_library_item_id: string | null;
};
const activeStatus = {queued: 'receiving', saved: 'importing', waiting_parse: 'parsing'} as const;
const workerLimits: Record<QueueStage, number> = {queued: 1, saved: 1, waiting_parse: 2};
const retryable = new Set([
  'research_process_admission_queue_limit', 'research_process_memory_limit',
  'research_process_timeout', 'research_document_parse_active', 'EBUSY', 'EAGAIN', 'ETIMEDOUT'
]);

/** SQLite owns the manifest and claims. The app's single-instance lock owns recovery of unfinished claims. */
export class ResearchDocumentImportBatches {
  private readonly controller = new AbortController();
  private readonly workers = new Set<Promise<void>>();
  private readonly running: Record<QueueStage, number> = {queued: 0, saved: 0, waiting_parse: 0};
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly documents: ResearchDocumentService, private readonly rootPath: string | null) {}

  async start(input: DocumentImportBatchStart): Promise<DocumentImportBatch> {
    this.controller.signal.throwIfAborted();
    this.repository.library.validateDestination(input.projectId);
    if (input.libraryItemId !== null && this.repository.library.get(input.libraryItemId).archived) throw new Error('research_library_item_archived');
    const requestHash = researchContentHash(JSON.stringify([input.projectId, input.libraryItemId, input.sourcePaths]));
    const findExisting = () => this.db.prepare('SELECT request_hash FROM research_document_import_batches WHERE id=?')
      .pluck().get(input.requestId);
    if (findExisting() === undefined) {
      const entries: Array<{stamp: string | null; error: string | null}> = [];
      for (let offset = 0; offset < input.sourcePaths.length; offset += 16) {
        entries.push(...await Promise.all(input.sourcePaths.slice(offset, offset + 16).map(async path => {
          try {return {stamp: await documentImportStamp(path), error: null};}
          catch (error) {return {stamp: null, error: importError(error)};}
        })));
      }
      this.controller.signal.throwIfAborted();
      this.db.transaction(() => {
        if (findExisting() !== undefined) return;
        this.repository.library.validateDestination(input.projectId);
        this.db.prepare('INSERT INTO research_document_import_batches VALUES (?,?,?,?,?)')
          .run(input.requestId, input.projectId, input.libraryItemId, requestHash, new Date().toISOString());
        const insert = this.db.prepare(`INSERT INTO research_document_import_entries
          (id,batch_id,position,filename,source_path,source_stamp,status,error) VALUES (?,?,?,?,?,?,?,?)`);
        input.sourcePaths.forEach((path, index) => {
          const {stamp, error} = entries[index];
          insert.run(`document_${randomUUID()}`, input.requestId, index, basename(path), path, stamp, error === null ? 'queued' : 'failed', error);
        });
      })();
    }
    if (findExisting() !== requestHash) throw new Error('research_document_import_request_conflict');
    const receipt = this.read({projectId: input.projectId, batchId: input.requestId});
    this.wake();
    return receipt;
  }

  read(input: DocumentImportBatchRef): DocumentImportBatch {
    const createdAt = this.db.prepare('SELECT created_at FROM research_document_import_batches WHERE id=? AND project_id IS ?')
      .pluck().get(input.batchId, input.projectId) as string | undefined;
    if (createdAt === undefined) throw new Error('research_document_import_batch_not_found');
    const entries = this.db.prepare(`SELECT id,filename,status,document_id AS documentId,error
      FROM research_document_import_entries WHERE batch_id=? ORDER BY position`)
      .all(input.batchId) as DocumentImportBatch['entries'];
    return {id: input.batchId, createdAt, entries};
  }

  list(projectId: string | null, offset: number): Array<{id: string; createdAt: string; total: number; pending: number; failed: number}> {
    return this.db.prepare(`SELECT b.id,b.created_at AS createdAt,count(*) AS total,
      sum(e.status NOT IN ('parsed','duplicate','failed')) AS pending,sum(e.status='failed') AS failed
      FROM research_document_import_batches b JOIN research_document_import_entries e ON e.batch_id=b.id
      WHERE b.project_id IS ? GROUP BY b.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT 20 OFFSET ?`)
      .all(projectId, offset) as ReturnType<ResearchDocumentImportBatches['list']>;
  }

  retry(input: DocumentImportBatchRef): DocumentImportBatch {
    this.repository.library.validateDestination(input.projectId);
    this.read(input);
    this.db.prepare(`UPDATE research_document_import_entries SET status=CASE
      WHEN document_id IS NOT NULL THEN 'waiting_parse' WHEN source_hash IS NOT NULL THEN 'saved' ELSE 'queued' END,
      attempts=0,retry_at=0,error=NULL WHERE batch_id=? AND status='failed'
      AND (document_id IS NOT NULL OR source_path IS NOT NULL)`).run(input.batchId);
    this.wake();
    return this.read(input);
  }

  recover(): void {
    this.db.exec(`UPDATE research_document_import_entries SET status=CASE status
      WHEN 'receiving' THEN 'queued' WHEN 'importing' THEN 'saved' ELSE 'waiting_parse' END
      WHERE status IN ('receiving','importing','parsing')`);
    this.wake();
    const cleanup = this.cleanupInterruptedDuplicates();
    this.workers.add(cleanup);
    void cleanup.catch(() => logWarn('research_document_import_duplicate_cleanup_failed'))
      .finally(() => this.workers.delete(cleanup));
  }

  async idle(): Promise<void> {
    while (this.workers.size) await Promise.allSettled([...this.workers]);
  }

  async shutdown(): Promise<void> {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.idle();
  }

  private wake(): void {
    if (this.controller.signal.aborted) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const stage of Object.keys(workerLimits) as QueueStage[]) {
      while (this.running[stage] < workerLimits[stage]) {
        const entry = this.db.prepare(`SELECT e.*,b.project_id,b.target_library_item_id FROM research_document_import_entries e
          JOIN research_document_import_batches b ON b.id=e.batch_id WHERE e.status=? AND e.retry_at<=?
          ORDER BY e.retry_at,b.created_at,b.rowid,e.position LIMIT 1`).get(stage, Date.now()) as Entry | undefined;
        if (!entry) break;
        this.transition(entry.id, stage, activeStatus[stage]);
        this.running[stage]++;
        const worker = this.run(stage, entry);
        this.workers.add(worker);
        void worker.catch(() => logWarn('research_document_import_worker_failed')).finally(() => {
          this.running[stage]--;
          this.workers.delete(worker);
          try {this.wake();}
          catch {logWarn('research_document_import_wake_failed');}
        });
      }
    }
    const next = this.db.prepare(`SELECT min(retry_at) FROM research_document_import_entries
      WHERE status IN ('queued','saved','waiting_parse') AND retry_at>?`).pluck().get(Date.now()) as number | null;
    if (next !== null) {
      this.timer = setTimeout(() => {
        try {this.wake();}
        catch {logWarn('research_document_import_wake_failed');}
      }, Math.max(1, next - Date.now()));
      this.timer.unref();
    }
  }

  private async run(stage: QueueStage, entry: Entry): Promise<void> {
    const signal = this.controller.signal;
    const current = activeStatus[stage];
    try {
      if (stage === 'waiting_parse') {
        if (entry.document_id === null) throw new Error('research_document_not_found');
        const document = this.repository.documents.get(entry.document_id);
        if (document.currentParseId === null || document.activeParseId !== null) {
          const parsed = await this.documents.parseForBatch(document.id, signal, () => {
            signal.throwIfAborted();
            this.repository.library.validateDestination(entry.project_id);
          });
          if (parsed.status !== 'ready') throw new Error(parsed.error ?? 'research_document_parse_failed');
        }
        signal.throwIfAborted();
        this.transition(entry.id, current, 'parsed');
        return;
      }
      if (entry.source_path === null) throw new Error('research_document_source_invalid');
      const staged = await documentImportLocation(this.rootPath, entry.id, entry.filename);
      if (stage === 'queued') {
        const sourceStamp = entry.source_stamp ?? await documentImportStamp(entry.source_path);
        this.db.prepare('UPDATE research_document_import_entries SET source_stamp=? WHERE id=? AND status=?')
          .run(sourceStamp, entry.id, current);
        const receipt = await receiveDocumentImport(entry.source_path, sourceStamp, staged.sourcePath, signal);
        this.db.prepare(`UPDATE research_document_import_entries SET status='saved',source_hash=?,size=?,attempts=0,retry_at=0,error=NULL
          WHERE id=? AND status=?`).run(receipt.sourceHash, receipt.size, entry.id, current);
        return;
      }
      if (entry.size === null || entry.source_hash === null) throw new Error('research_document_source_invalid');
      await verifyDocumentSource(staged.root, researchRelativePath(relative(staged.root, staged.sourcePath)), entry.size, entry.source_hash, signal);
      const base = {sourcePath: entry.source_path, projectId: entry.project_id};
      const title = basename(entry.filename, extname(entry.filename)).trim().slice(0, 1000) || '文献';
      await this.documents.importStaged(entry.target_library_item_id === null ?
        {...base, target: 'new-item', title, citationKey: 'paper'} :
        {...base, target: 'library-item', libraryItemId: entry.target_library_item_id},
        {...staged, size: entry.size, sourceHash: entry.source_hash},
        (document, created) => {
          const result = this.db.prepare(`UPDATE research_document_import_entries SET status=?,document_id=?,
            source_path=NULL,source_stamp=NULL,attempts=0,retry_at=0,error=NULL WHERE id=? AND status=?`)
            .run(created ? 'waiting_parse' : 'duplicate', document.id, entry.id, current);
          if (result.changes !== 1) throw new Error('research_document_import_claim_changed');
        }, signal);
      if (this.db.prepare("SELECT 1 FROM research_document_import_entries WHERE id=? AND status='duplicate'").get(entry.id)) {
        await this.removeDuplicateCopy(entry.id, staged.directory).catch(() => logWarn('research_document_import_duplicate_cleanup_failed'));
      }
    } catch (error) {
      if (signal.aborted) return;
      const code = importError(error);
      const retry = retryable.has(code) && entry.attempts < 3;
      this.db.prepare(`UPDATE research_document_import_entries SET status=?,error=?,attempts=attempts+1,retry_at=? WHERE id=? AND status=?`)
        .run(retry ? stage : 'failed', code, retry ? Date.now() + 1000 * 2 ** entry.attempts : 0, entry.id, current);
    }
  }

  private async cleanupInterruptedDuplicates(): Promise<void> {
    const duplicates = this.db.prepare(`SELECT id,filename FROM research_document_import_entries
      WHERE status='duplicate' AND source_hash IS NOT NULL ORDER BY id`).all() as Array<Pick<Entry, 'id' | 'filename'>>;
    for (const entry of duplicates) {
      if (this.controller.signal.aborted) return;
      try {
        const {directory} = await documentImportLocation(this.rootPath, entry.id, entry.filename);
        await this.removeDuplicateCopy(entry.id, directory);
      } catch {logWarn('research_document_import_duplicate_cleanup_failed');}
    }
  }

  private async removeDuplicateCopy(id: string, directory: string): Promise<void> {
    await rm(directory, {recursive: true, force: true});
    this.db.prepare("UPDATE research_document_import_entries SET source_hash=NULL,size=NULL WHERE id=? AND status='duplicate'")
      .run(id);
  }

  private transition(id: string, from: EntryStatus, to: EntryStatus): void {
    const result = this.db.prepare('UPDATE research_document_import_entries SET status=?,error=NULL WHERE id=? AND status=?').run(to, id, from);
    if (result.changes !== 1) throw new Error('research_document_import_claim_changed');
  }
}

function importError(error: unknown): string {
  if (!(error instanceof Error)) return 'research_document_import_failed';
  const code = error.message.split(':', 1)[0];
  if (/^research_[a-z_]+$/u.test(code)) return code;
  const systemCode = (error as NodeJS.ErrnoException).code;
  return systemCode && /^(?:ENOENT|EACCES|EPERM|ENOSPC|EBUSY|EAGAIN|ETIMEDOUT)$/u.test(systemCode) ?
    systemCode : 'research_document_import_failed';
}
