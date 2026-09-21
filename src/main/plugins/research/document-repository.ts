import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { researchDocumentContentSchema, researchDocumentRunSchema, researchDocumentSchema } from '../../../shared/schemas/research-documents';
import type { ResearchRepository } from './repository';
import type { BibliographyEntry } from './library-repository';
import type { ResearchLiterature } from '../../../shared/types';

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
    projectId: string | null; filename: string; mediaType: string; sourcePath: string; sourceHash: string; size: number }): { document: ResearchDocument; created: boolean } {
    return this.db.transaction(() => {
      this.research.library.validateDestination(input.projectId);
      let libraryItemId = input.libraryItemId;
      if (libraryItemId === null) {
        if (input.entry === null) throw new Error('research_document_metadata_required');
        libraryItemId = this.research.library.import([input.entry], input.projectId).items[0].id;
      } else {
        if (input.entry !== null) throw new Error('research_document_target_invalid');
        if (this.research.library.get(libraryItemId).archived) throw new Error('research_library_item_archived');
        if (input.projectId !== null) this.research.library.link(libraryItemId, input.projectId, true);
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

  complete(documentId: string, parseId: string, input: StoredDocumentContent): void {
    const data = storedDocumentContentSchema.parse(input);
    this.db.transaction(() => {
      const document = this.get(documentId);
      if (document.activeParseId !== parseId) throw new Error('research_document_parse_stale');
      if (this.research.library.get(document.libraryItemId).archived) throw new Error('research_library_item_archived');
      if (data.content.sourceHash !== document.sourceHash) throw new Error('research_document_source_changed');
      const timestamp = this.now();
      const result = this.db.prepare("UPDATE research_document_parses SET status = 'ready', data_json = ?, finished_at = ? WHERE id = ? AND document_id = ? AND status = 'running'")
        .run(JSON.stringify(data), timestamp, parseId, documentId);
      if (result.changes !== 1) throw new Error('research_document_parse_stale');
      this.db.prepare("UPDATE research_documents SET status = 'ready', current_parse_id = ?, active_parse_id = NULL, error = NULL, updated_at = ? WHERE id = ?")
        .run(parseId, timestamp, documentId);
      if (document.currentParseId !== null) this.removeIndex(document.currentParseId);
      this.index(document, parseId, data);
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
    if (row.status !== 'ready' || row.data_json === null) throw new Error('research_document_parse_not_ready');
    return { run: toRun(row), data: storedDocumentContentSchema.parse(JSON.parse(row.data_json)) };
  }

  syncLibraryIndex(libraryItemId: string): void {
    const archived = this.research.library.get(libraryItemId).archived;
    for (const document of this.list(libraryItemId)) {
      if (document.currentParseId === null) continue;
      if (archived) this.removeIndex(document.currentParseId);
      else this.index(document, document.currentParseId, this.parsed(document.id, document.currentParseId).data);
    }
    this.research.flushKnowledgeFromSource();
  }

  recover(): void {
    const rows = this.db.prepare("SELECT id,active_parse_id FROM research_documents WHERE active_parse_id IS NOT NULL").all() as Array<{ id: string; active_parse_id: string }>;
    for (const row of rows) this.fail(row.id, row.active_parse_id, 'research_document_parse_interrupted', false);
  }

  private row(id: string): DocumentRow {
    const row = this.db.prepare('SELECT * FROM research_documents WHERE id = ?').get(id) as DocumentRow | undefined;
    if (row === undefined) throw new Error('research_document_not_found');
    return row;
  }

  private removeIndex(parseId: string): void {
    this.db.prepare('DELETE FROM research_knowledge_documents WHERE id = ?').run(`document:${parseId}`);
  }

  private index(document: ResearchDocument, parseId: string, data: StoredDocumentContent): void {
    const chunks = data.content.blocks.filter((block) => block.text.trim()).map((block) => ({ content: block.text, locator: block.locator }));
    const input = { id: `document:${parseId}`, projectId: null as string | null, sourceType: 'file' as const, sourceId: document.libraryItemId,
      title: `${this.research.library.get(document.libraryItemId).metadata.title} — ${document.filename}`, content: data.content.content, chunks, embeddingPolicy: 'none' as const };
    this.research.knowledge.upsertFromSource(input);
    this.research.queueKnowledgeFromSource(input);
  }
}

function toRun(row: RunRow): ResearchDocumentRun {
  return researchDocumentRunSchema.parse({ id: row.id, documentId: row.document_id, status: row.status, error: row.error, createdAt: row.created_at, finishedAt: row.finished_at });
}
