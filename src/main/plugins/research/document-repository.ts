import type { Database } from 'better-sqlite3';
import {indexDocumentBlocks} from './index-files';
import { z } from 'zod';
import { researchDocumentContentSchema, researchDocumentRunSchema, researchDocumentSchema } from '../../../shared/schemas/research-documents';
import type { ResearchRepository } from './repository';
import type { BibliographyEntry } from './library-repository';
import type { ResearchLiterature } from '../../../shared/types';
import {logWarn} from '../../services/errors';
import {createHash} from 'node:crypto';
import {researchDocumentCoordinateSnapshotSchema, type ResearchDocumentCoordinateSnapshot,
  type ResearchDocumentCoordinateInspection} from '../../../shared/schemas/research-document-coordinates';

export type ResearchDocument = z.infer<typeof researchDocumentSchema>;
export type ResearchDocumentRun = z.infer<typeof researchDocumentRunSchema>;
export const storedDocumentContentSchema = z.object({
  content: researchDocumentContentSchema, outputPath: z.string(), files: z.record(z.string(), z.string())
}).strict();
export type StoredDocumentContent = z.infer<typeof storedDocumentContentSchema>;
type DocumentRow = { id: string; library_item_id: string; filename: string; media_type: string; source_path: string; source_hash: string;
  size: number; status: string; current_parse_id: string | null; active_parse_id: string | null; error: string | null; created_at: string; updated_at: string };
type RunRow = { id: string; document_id: string; status: string; data_json: string | null; error: string | null; created_at: string; finished_at: string | null };

export class ResearchDocumentRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  get(id: string): ResearchDocument {
    const row = this.row(id);
    return researchDocumentSchema.parse({ id: row.id, libraryItemId: row.library_item_id, filename: row.filename, mediaType: row.media_type,
      sourceHash: row.source_hash, size: row.size, status: row.status, currentParseId: row.current_parse_id, activeParseId: row.active_parse_id,
      error: row.error, createdAt: row.created_at, updatedAt: row.updated_at });
  }

  list(libraryItemId: string): ResearchDocument[] {
    this.research.library.get(libraryItemId);
    return (this.db.prepare('SELECT id FROM research_documents WHERE library_item_id = ? ORDER BY created_at, id').all(libraryItemId) as Array<{ id: string }>).map((row) => this.get(row.id));
  }

  import(input: { id: string; libraryItemId: string | null; entry: { metadata: ResearchLiterature; bibliography: BibliographyEntry } | null;
    projectId: string | null; filename: string; mediaType: string; sourcePath: string; sourceHash: string; size: number }, notify: boolean): { document: ResearchDocument; created: boolean } {
    return this.db.transaction(() => {
      this.research.library.validateDestination(input.projectId);
      let libraryItemId = input.libraryItemId;
      if (libraryItemId === null) {
        if (input.entry === null) throw new Error('research_document_metadata_required');
        libraryItemId = this.research.library.import([input.entry], input.projectId, {notify}).items[0].id;
      } else {
        if (input.entry !== null) throw new Error('research_document_target_invalid');
        if (this.research.library.get(libraryItemId).archived) throw new Error('research_library_item_archived');
        if (input.projectId !== null) this.research.library.link(libraryItemId, input.projectId, true, {notify});
      }
      const existing = this.db.prepare('SELECT id FROM research_documents WHERE library_item_id = ? AND source_hash = ?').get(libraryItemId, input.sourceHash) as { id: string } | undefined;
      if (existing !== undefined) return { document: this.get(existing.id), created: false };
      const timestamp = this.now();
      this.db.prepare(`INSERT INTO research_documents
        (id,library_item_id,filename,media_type,source_path,source_hash,size,status,current_parse_id,active_parse_id,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'imported',NULL,NULL,NULL,?,?)`)
        .run(input.id, libraryItemId, input.filename, input.mediaType, input.sourcePath, input.sourceHash, input.size, timestamp, timestamp);
      return { document: this.get(input.id), created: true };
    })();
  }

  sourcePath(id: string): string { return this.row(id).source_path; }

  getForParse(parseId: string): ResearchDocument {
    const row = this.db.prepare('SELECT document_id FROM research_document_parses WHERE id=?').get(parseId) as {document_id: string} | undefined;
    if (row === undefined) throw new Error('research_document_parse_not_found');
    return this.get(row.document_id);
  }

  importWithReceipt(input: Parameters<ResearchDocumentRepository['import']>[0], record: (document: ResearchDocument) => void): {document: ResearchDocument; created: boolean} {
    const previous = input.libraryItemId === null ? null : this.research.library.get(input.libraryItemId);
    const result = this.db.transaction(() => {
      const result = this.import(input, false);
      record(result.document);
      return result;
    })();
    if (previous === null || (input.projectId !== null && !previous.projectIds.includes(input.projectId))) {
      // The document and its receipt already committed; an observer error cannot roll them back.
      try {this.research.library.onChanged?.([this.research.library.get(result.document.libraryItemId)], previous === null ? 'import' : 'link');}
      catch {logWarn('research_document_library_change_notify_failed', {metadata: {documentId: result.document.id}});}
    }
    return result;
  }

  begin(documentId: string, parseId: string): void {
    this.db.transaction(() => {
      const document = this.get(documentId);
      if (this.research.library.get(document.libraryItemId).archived) throw new Error('research_library_item_archived');
      if (document.activeParseId !== null) throw new Error('research_document_parse_active');
      const timestamp = this.now();
      this.db.prepare(`INSERT INTO research_document_parses (id,document_id,status,data_json,error,created_at,finished_at)
        VALUES (?,?,'running',NULL,NULL,?,NULL)`).run(parseId, documentId, timestamp);
      this.db.prepare("UPDATE research_documents SET status = 'parsing', active_parse_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(parseId, timestamp, documentId);
    })();
  }

  complete(documentId: string, parseId: string, input: StoredDocumentContent, coordinateInput: ResearchDocumentCoordinateSnapshot | null): void {
    const data = storedDocumentContentSchema.parse(input);
    const coordinates = coordinateInput === null ? null : researchDocumentCoordinateSnapshotSchema.parse(coordinateInput);
    if (coordinates !== null) this.requireCoordinateBinding(data, coordinates);
    this.db.transaction(() => {
      const document = this.get(documentId);
      if (document.activeParseId !== parseId) throw new Error('research_document_parse_stale');
      if (this.research.library.get(document.libraryItemId).archived) throw new Error('research_library_item_archived');
      if (data.content.sourceHash !== document.sourceHash) throw new Error('research_document_source_changed');
      const timestamp = this.now();
      const result = this.db.prepare("UPDATE research_document_parses SET status = 'ready', data_json = ?, finished_at = ? WHERE id = ? AND document_id = ? AND status = 'running'")
        .run(JSON.stringify(data), timestamp, parseId, documentId);
      if (result.changes !== 1) throw new Error('research_document_parse_stale');
      if (coordinates !== null) {
        const json = JSON.stringify(coordinates);
        const snapshotHash = createHash('sha256').update(json).digest('hex');
        this.db.prepare(`INSERT INTO research_document_parse_coordinates
          (parse_id,document_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?)`)
          .run(parseId, documentId, json, snapshotHash, timestamp);
        this.db.prepare('UPDATE research_document_parses SET coordinate_snapshot_hash=? WHERE id=? AND document_id=?')
          .run(snapshotHash, parseId, documentId);
      }
      this.db.prepare("UPDATE research_documents SET status = 'ready', current_parse_id = ?, active_parse_id = NULL, error = NULL, updated_at = ? WHERE id = ?")
        .run(parseId, timestamp, documentId);
      if (document.currentParseId !== null) this.removeIndex(document.currentParseId);
      const indexed = this.index(document, parseId, data);
      this.research.evidence.sourceMigrations.proposeForParse(documentId, parseId);
      this.research.queueKnowledgeFromSource(indexed);
    })();
    this.research.flushKnowledgeFromSource();
  }

  fail(documentId: string, parseId: string, error: string, cancelled: boolean): void {
    this.db.transaction(() => {
      const timestamp = this.now();
      const status = cancelled ? 'cancelled' : 'failed';
      this.db.prepare("UPDATE research_document_parses SET status = ?, error = ?, finished_at = ? WHERE id = ? AND document_id = ? AND status = 'running'")
        .run(status, error, timestamp, parseId, documentId);
      this.db.prepare('UPDATE research_documents SET status = ?, active_parse_id = NULL, error = ?, updated_at = ? WHERE id = ? AND active_parse_id = ?')
        .run(status, error, timestamp, documentId, parseId);
    })();
  }

  runs(documentId: string): ResearchDocumentRun[] {
    this.get(documentId);
    return (this.db.prepare('SELECT * FROM research_document_parses WHERE document_id = ? ORDER BY created_at DESC, rowid DESC').all(documentId) as RunRow[]).map(toRun);
  }

  parsed(documentId: string, parseId: string): { run: ResearchDocumentRun; data: StoredDocumentContent } {
    this.get(documentId);
    const row = this.db.prepare('SELECT * FROM research_document_parses WHERE id = ? AND document_id = ?').get(parseId, documentId) as RunRow | undefined;
    if (row === undefined) throw new Error('research_document_parse_not_found');
    // 已失效的解析明确返回待重建状态；保留原文身份，不静默指向新块。
    if (row.status === 'failed' && row.error === 'research_document_parse_superseded') {
      throw new Error('research_document_parse_superseded');
    }
    if (row.status !== 'ready' || row.data_json === null) throw new Error('research_document_parse_not_ready');
    return { run: toRun(row), data: parseStoredContent(row.data_json) };
  }

  coordinates(documentId: string, parseId: string): ResearchDocumentCoordinateInspection | null {
    const {data} = this.parsed(documentId, parseId);
    const row = this.db.prepare(`SELECT p.coordinate_snapshot_hash AS expected_hash,c.document_id,c.snapshot_json,c.snapshot_hash
      FROM research_document_parses p LEFT JOIN research_document_parse_coordinates c ON c.parse_id=p.id
      WHERE p.id=? AND p.document_id=?`).get(parseId, documentId) as {
        expected_hash: string | null; document_id: string | null; snapshot_json: string | null; snapshot_hash: string | null
      };
    if (row.expected_hash === null && row.snapshot_json === null) return null;
    if (row.snapshot_json === null) throw new Error('research_document_coordinate_snapshot_missing');
    if (row.snapshot_hash !== row.expected_hash) throw new Error('research_document_coordinate_snapshot_invalid');
    if (row.document_id !== documentId) throw new Error('research_document_coordinate_binding_changed');
    let value: unknown;
    try {value = JSON.parse(row.snapshot_json);}
    catch {throw new Error('research_document_coordinate_snapshot_invalid');}
    const parsed = researchDocumentCoordinateSnapshotSchema.safeParse(value);
    if (!parsed.success || createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex') !== row.snapshot_hash) {
      throw new Error('research_document_coordinate_snapshot_invalid');
    }
    this.requireCoordinateBinding(data, parsed.data);
    return {snapshot: parsed.data, snapshotHash: row.snapshot_hash};
  }

  private requireCoordinateBinding(data: StoredDocumentContent, coordinates: ResearchDocumentCoordinateSnapshot): void {
    if (coordinates.sourceHash !== data.content.sourceHash ||
        coordinates.parseHash !== createHash('sha256').update(JSON.stringify(data.content)).digest('hex') ||
        coordinates.artifact.path !== data.content.artifacts.structuredContent ||
        coordinates.pages.some(page => page.page > data.content.pageCount ||
          (page.frame === null) !== (data.content.parseMode === 'html'))) throw new Error('research_document_coordinate_binding_changed');
    const frames = new Map(coordinates.pages.map(page => [page.page, page.frame]));
    for (const block of data.content.blocks) for (const location of block.locations) {
      const frame = frames.get(location.page);
      if (frame === undefined) throw new Error('research_document_coordinate_page_missing');
      if (frame !== null) {
        const [x1, y1, x2, y2] = location.bbox;
        if (x1 < 0 || y1 < 0 || x2 > frame.width || y2 > frame.height || x2 <= x1 || y2 <= y1) {
          throw new Error('research_document_coordinate_region_invalid');
        }
      }
    }
  }

  syncLibraryIndex(libraryItemId: string): void {
    const archived = this.research.library.get(libraryItemId).archived;
    for (const document of this.list(libraryItemId)) {
      if (document.currentParseId === null) continue;
      if (archived) this.removeIndex(document.currentParseId);
      else this.research.queueKnowledgeFromSource(this.index(document, document.currentParseId, this.parsed(document.id, document.currentParseId).data));
    }
    this.research.flushKnowledgeFromSource();
  }

  recover(): void {
    const rows = this.db.prepare("SELECT id,active_parse_id FROM research_documents WHERE active_parse_id IS NOT NULL").all() as Array<{ id: string; active_parse_id: string }>;
    for (const row of rows) this.fail(row.id, row.active_parse_id, 'research_document_parse_interrupted', false);
  }

  /** 待重解析的文档：有原文、没有当前结果。用于显式批量重解析。 */
  needsReparse(): ResearchDocument[] {
    return (this.db.prepare("SELECT id FROM research_documents WHERE current_parse_id IS NULL AND active_parse_id IS NULL AND status IN ('imported','failed')")
      .all() as Array<{ id: string }>).map((row) => this.get(row.id));
  }

  private row(id: string): DocumentRow {
    const row = this.db.prepare('SELECT * FROM research_documents WHERE id = ?').get(id) as DocumentRow | undefined;
    if (row === undefined) throw new Error('research_document_not_found');
    return row;
  }

  private removeIndex(parseId: string): void {
    // 删块前先把指向这些块的证据标成失效：证据行本身不删（原文与出处还在），只是块定位
    // 不再成立。顺序反了就去不到块 id 了（提案 §8.4）。
    this.research.evidence.invalidateChunksOf(`document:${parseId}`);
    this.db.prepare('DELETE FROM research_knowledge_documents WHERE id = ?').run(`document:${parseId}`);
  }

  private index(document: ResearchDocument, parseId: string, data: StoredDocumentContent) {
    const chunks = indexDocumentBlocks(data.content.blocks);
    const input = { id: `document:${parseId}`, projectId: null as string | null, sourceType: 'file' as const, sourceId: document.libraryItemId,
      title: `${this.research.library.get(document.libraryItemId).metadata.title} — ${document.filename}`, content: data.content.content, chunks, embeddingPolicy: 'none' as const };
    this.research.knowledge.upsertFromSource(input);
    return input;
  }
}

function toRun(row: RunRow): ResearchDocumentRun {
  return researchDocumentRunSchema.parse({ id: row.id, documentId: row.document_id, status: row.status, error: row.error, createdAt: row.created_at, finishedAt: row.finished_at });
}

/** Read only the current stored parse contract; incompatible results require explicit reparse. */
function parseStoredContent(json: string): StoredDocumentContent {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error('research_document_parse_corrupt'); }
  if (typeof value !== 'object' || value === null || !('content' in value)
      || typeof (value as { content?: unknown }).content !== 'object'
      || !('contractVersion' in ((value as { content: object }).content))) {
    throw new Error('research_document_parse_legacy');
  }
  return storedDocumentContentSchema.parse(value);
}
