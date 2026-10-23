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
    // 旧代际（或已被代际切换撤销）的结果不构成“当前结果”。提案 §8.4 要求这类引用明确
    // 返回「引用待重建」，而不是 `not_ready`（那是“还在跑”）也不是 `not_found`（那是删了）。
    // 原文仍可按文档身份打开，只是不再承诺块定位，更不允许静默指向新块。
    if (row.status === 'failed' && row.error === 'research_document_parse_superseded') {
      throw new Error('research_document_parse_superseded');
    }
    if (row.status !== 'ready' || row.data_json === null) throw new Error('research_document_parse_not_ready');
    return { run: toRun(row), data: parseStoredContent(row.data_json) };
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

  /**
   * 启动时的一次性派生重建（提案 §8「无向后兼容」）。
   *
   * 旧代际（Docling）的 `data_json` 不反序列化、不迁移。事务内只做三件事：解除
   * `current_parse_id`/`active_parse_id` 引用、把解析记录标成旧代际失败、撤掉指向旧块的检索条目。
   * 原文、sourceHash、元数据、引用键与用户内容全部保留——文档本身只回到 `imported`，
   * 即“有原文、无结果”，就是它的准确含义。
   *
   * 可重复执行：`marker` 写入 `research_evidence_source_metadata`（本表已有键值语义，且无需
   * 改 CHECK 约束）；切换后文档的 `current_parse_id` 已为 NULL，再次启动走空集合。
   */
  switchDerivationGeneration(contractVersion: number): boolean {
    const key = 'derivation-generation';
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT contract_version FROM research_generations WHERE name = ?')
        .get(key) as { contract_version: number } | undefined;
      if (current?.contract_version === contractVersion) return false;
      const stale = this.db.prepare('SELECT id,current_parse_id FROM research_documents WHERE current_parse_id IS NOT NULL OR active_parse_id IS NOT NULL').all() as Array<{ id: string; current_parse_id: string | null }>;
      for (const row of stale) {
        if (row.current_parse_id !== null) this.removeIndex(row.current_parse_id);
        // 旧结果的“成功”不再成立：标成 failed 而不是留成 ready，否则 `parsed()` 会把它当当前结果返回。
        this.db.prepare("UPDATE research_document_parses SET status = 'failed', error = 'research_document_parse_superseded' WHERE document_id = ? AND status IN ('ready','running')").run(row.id);
      }
      this.db.prepare("UPDATE research_documents SET status = 'imported',current_parse_id = NULL,active_parse_id = NULL,error = NULL,updated_at = ?").run(this.now());
      this.db.prepare('INSERT INTO research_generations (name,contract_version,switched_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET contract_version = excluded.contract_version,switched_at = excluded.switched_at')
        .run(key, contractVersion, this.now());
      return true;
    })();
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

/**
 * 反序列化一条历史解析记录（提案 §8「派生数据切换：无向后兼容」）。
 *
 * 旧代际（Docling）的 `data_json` **不解析**：它缺少 `contractVersion`/`engine`/工件身份，
 * 也指向已被删除的工件目录。把它当作“待重建”报出去，而不是让一个字段缺失的 zod 错误
 * 傅到 UI 层——那会把「旧结果不再读取」变成「一条看不懂的校验失败」。
 */
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
