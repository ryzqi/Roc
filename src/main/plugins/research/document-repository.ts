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
import type {ResearchProcessingTrace} from './processing-trace';
import {knowledgeChunkVersion} from './knowledge-chunks';
import {paperSemanticEnrichmentSchema} from '../../../shared/schemas/research-paper-semantics';
import {assertPaperSemanticEnrichment} from './paper-semantic-service';
import {scholarlyEnrichmentSchema} from '../../../shared/schemas/research-scholarly-parser';
import {assertScholarlyEnrichment} from './scholarly-parser-adapter';
import {paperIrArtifactSchema, paperIrV2Version, type PaperIRMetadata} from '../../../shared/schemas/research-paper-ir-v2';
import {buildPaperIR} from './paper-ir-builder';
import {assertPaperIRArtifact} from './paper-ir-repository';
import type {PreparedKnowledgeEmbeddings} from './embedding-service';
import {betterBibtexKey} from './cite-key';
import {literatureIdentity, literatureSourceIdentity} from './literature-identity';
import type {DocumentImportEntry} from './document-import-metadata';
import {readResearchDocumentStatuses} from './document-status';
import type {ResearchDocumentStatusRequest, ResearchDocumentStatusResult} from '../../../shared/schemas/research-document-status';
import type {ResearchParseTier} from '../../../shared/schemas/research-production';

type ParseIntent = {tier: ResearchParseTier; origin: 'direct' | 'acquisition' | 'batch'};

export type ResearchDocument = z.infer<typeof researchDocumentSchema>;
export type ResearchDocumentRun = z.infer<typeof researchDocumentRunSchema>;
export const storedDocumentContentSchema = z.object({
  content: researchDocumentContentSchema, outputPath: z.string(), files: z.record(z.string(), z.string()),
  semanticEnrichment: paperSemanticEnrichmentSchema.optional(), scholarlyEnrichment: scholarlyEnrichmentSchema.optional(),
  paperIR: paperIrArtifactSchema.optional(), paperIRVersion: z.literal(paperIrV2Version).optional()
}).strict().refine(value => value.paperIRVersion === undefined || value.paperIR !== undefined,
  'research_paper_ir_artifact_missing');
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

  statusMany(request: ResearchDocumentStatusRequest): ResearchDocumentStatusResult {
    return readResearchDocumentStatuses(this.db, this.research, request);
  }

  import(input: { id: string; libraryItemId: string | null; entry: { metadata: ResearchLiterature; bibliography: BibliographyEntry } | null;
    sourceEntries?: readonly DocumentImportEntry[]; automaticCitationKey?: boolean;
    projectId: string | null; filename: string; mediaType: string; sourcePath: string; sourceHash: string; size: number }, notify: boolean): { document: ResearchDocument; created: boolean } {
    const result = this.db.transaction(() => {
      this.research.library.validateDestination(input.projectId);
      let libraryItemId = input.libraryItemId;
      if (libraryItemId === null) {
        if (input.entry === null) throw new Error('research_document_metadata_required');
        let entries = [...input.sourceEntries ?? [], input.entry];
        const primary = entries[0];
        if (entries.some(entry => literatureIdentity(entry.metadata) !== literatureIdentity(primary.metadata))) {
          throw new Error('research_document_metadata_identity_mismatch');
        }
        if (input.automaticCitationKey === true) {
          const existing = this.research.library.findByIdentity(literatureIdentity(primary.metadata),
            entries.map(entry => literatureSourceIdentity(entry.metadata)));
          if (existing?.archived) throw new Error('research_library_item_archived');
          // All asynchronous metadata preparation is finished; allocation sees the current database keys.
          const citationKey = existing?.bibliography.citationKey ?? betterBibtexKey(primary.metadata, this.research.library.usedCitationKeys());
          entries = entries.map(entry => ({...entry, bibliography: {...entry.bibliography, citationKey}}));
        }
        const imported = this.research.library.import(entries, input.projectId, {notify, flush: false, skipArchived: input.automaticCitationKey === true});
        if (imported.items.length === 0 || imported.items.some(item => item.id !== imported.items[0].id)) {
          throw new Error('research_document_metadata_identity_mismatch');
        }
        libraryItemId = imported.items[0].id;
      } else {
        if (input.entry !== null || input.sourceEntries?.length) throw new Error('research_document_target_invalid');
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
    if (!this.db.inTransaction) this.wakePublishedKnowledge();
    return result;
  }

  sourcePath(id: string): string { return this.row(id).source_path; }

  getForParse(parseId: string): ResearchDocument {
    const row = this.db.prepare('SELECT document_id FROM research_document_parses WHERE id=?').get(parseId) as {document_id: string} | undefined;
    if (row === undefined) throw new Error('research_document_parse_not_found');
    return this.get(row.document_id);
  }

  importWithReceipt(input: Parameters<ResearchDocumentRepository['import']>[0], record: (document: ResearchDocument, created: boolean) => void): {document: ResearchDocument; created: boolean} {
    const previous = input.libraryItemId === null ? null : this.research.library.get(input.libraryItemId);
    const result = this.db.transaction(() => {
      const result = this.import(input, false);
      record(result.document, result.created);
      return result;
    })();
    if (previous === null || (input.projectId !== null && !previous.projectIds.includes(input.projectId))) {
      // The document and its receipt already committed; an observer error cannot roll them back.
      try {this.research.library.onChanged?.([this.research.library.get(result.document.libraryItemId)], previous === null ? 'import' : 'link');}
      catch {logWarn('research_document_library_change_notify_failed', {metadata: {documentId: result.document.id}});}
    }
    this.wakePublishedKnowledge();
    return result;
  }

  begin(documentId: string, parseId: string, intent?: ParseIntent): void {
    this.db.transaction(() => {
      const document = this.get(documentId);
      if (this.research.library.get(document.libraryItemId).archived) throw new Error('research_library_item_archived');
      if (document.activeParseId !== null) throw new Error('research_document_parse_active');
      const timestamp = this.now();
      this.db.prepare(`INSERT INTO research_document_parses (id,document_id,status,data_json,error,created_at,finished_at)
        VALUES (?,?,'running',NULL,NULL,?,NULL)`).run(parseId, documentId, timestamp);
      if (intent) this.db.prepare('INSERT INTO research_document_parse_intents VALUES (?,?,?)').run(parseId, intent.tier, intent.origin);
      this.db.prepare("UPDATE research_documents SET status = 'parsing', active_parse_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(parseId, timestamp, documentId);
    })();
  }

  complete(documentId: string, parseId: string, input: StoredDocumentContent, coordinateInput: ResearchDocumentCoordinateSnapshot | null,
    trace?: ResearchProcessingTrace, prepared?: PreparedKnowledgeEmbeddings, deferPaperCard = false): void {
    const data = storedDocumentContentSchema.parse(input);
    if (data.semanticEnrichment) assertPaperSemanticEnrichment(data.semanticEnrichment, data.content.blocks, data.content.structure);
    if (data.scholarlyEnrichment) assertScholarlyEnrichment(data.scholarlyEnrichment, data.content.sourceHash, data.content.blocks);
    const coordinates = coordinateInput === null ? null : researchDocumentCoordinateSnapshotSchema.parse(coordinateInput);
    if (coordinates !== null) this.requireCoordinateBinding(data, coordinates);
    if (data.paperIR) assertPaperIRArtifact(data.paperIR, this.buildPaperIR(documentId, parseId, data));
    else if (data.content.quality) throw new Error('research_paper_ir_artifact_missing');
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
      const indexed = this.index(document, parseId, data, trace);
      this.research.evidence.sourceMigrations.proposeForParse(documentId, parseId);
      if (deferPaperCard) this.research.knowledgeJobs.enqueue(indexed.id);
      else this.research.queueKnowledgeFromSource(indexed);
      if (prepared) {
        this.storePrepared(prepared);
        this.research.knowledgeJobs.acceptPrepared(indexed.id, prepared.identity);
      }
    })();
    this.wakePublishedKnowledge();
  }

  private wakePublishedKnowledge(): void {
    const wake = (): void => {
      try {this.research.flushKnowledgeFromSource();}
      catch {logWarn('research_document_knowledge_wake_failed');}
    };
    // A caller can publish inside a larger transaction. Workers only read committed outbox rows.
    if (this.db.inTransaction) queueMicrotask(wake);
    else wake();
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
    const document = this.get(documentId);
    const row = this.db.prepare('SELECT * FROM research_document_parses WHERE id = ? AND document_id = ?').get(parseId, documentId) as RunRow | undefined;
    if (row === undefined) throw new Error('research_document_parse_not_found');
    // 已失效的解析明确返回待重建状态；保留原文身份，不静默指向新块。
    if (row.status === 'failed' && row.error === 'research_document_parse_superseded') {
      throw new Error('research_document_parse_superseded');
    }
    if (row.status !== 'ready' || row.data_json === null) throw new Error('research_document_parse_not_ready');
    const data = parseStoredContent(row.data_json);
    if (data.paperIR) {
      if (data.paperIR.identity.paperId !== document.libraryItemId) throw new Error('research_paper_ir_scope_invalid');
      assertPaperIRArtifact(data.paperIR, this.buildPaperIR(documentId, parseId, data, data.paperIR.metadata));
    }
    return { run: toRun(row), data };
  }

  buildPaperIR(documentId: string, parseId: string, data: StoredDocumentContent, snapshot?: PaperIRMetadata) {
    const document = this.get(documentId), metadata = this.research.library.get(document.libraryItemId).metadata;
    return buildPaperIR({identity: {paperId: document.libraryItemId, documentId, parseId,
      knowledgeDocumentId: `document:${parseId}`, sourceHash: document.sourceHash, parserFingerprint: data.content.parserFingerprint},
      content: data.content, structure: data.semanticEnrichment?.structure,
      metadata: snapshot ?? {title: metadata.title, authors: metadata.authors, doi: metadata.doi, year: metadata.publishedYear, origin: 'library'},
      scholarlyEnrichment: data.scholarlyEnrichment});
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
      if (frame !== null && location.bbox !== null) {
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
      if (archived) {
        this.research.scientificIndex.retireSource(null, document.id);
        this.removeIndex(document.currentParseId);
      } else {
        const data = this.parsed(document.id, document.currentParseId).data;
        const exists = this.db.prepare('SELECT 1 FROM research_knowledge_documents WHERE id=?').get(`document:${document.currentParseId}`);
        const input = exists ? this.indexSource(document.id, document.currentParseId, data).input
          : this.index(document, document.currentParseId, data);
        this.research.queueKnowledgeFromSource(input);
      }
    }
    this.research.flushKnowledgeFromSource();
  }

  recover(): Array<{id: string; tier: ResearchParseTier | null}> {
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id,active_parse_id FROM research_documents WHERE active_parse_id IS NOT NULL')
        .all() as Array<{id: string; active_parse_id: string}>;
      for (const row of rows) this.fail(row.id, row.active_parse_id, 'research_document_parse_interrupted', false);
      return this.db.prepare(`SELECT d.id,i.tier FROM research_documents d JOIN research_library l ON l.id=d.library_item_id
        LEFT JOIN research_document_parse_intents i ON i.parse_id=(
          SELECT p.id FROM research_document_parses p WHERE p.document_id=d.id ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1)
        WHERE d.error='research_document_parse_interrupted' AND l.archived=0
          AND (i.origin='direct' OR (i.origin IS NULL AND NOT EXISTS (
            SELECT 1 FROM research_paper_acquisition_jobs a WHERE a.document_id=d.id AND a.stage='parse'
              AND a.status IN ('queued','running'))))
        ORDER BY d.updated_at,d.id`).all() as Array<{id: string; tier: ResearchParseTier | null}>;
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

  private index(document: ResearchDocument, parseId: string, data: StoredDocumentContent, suppliedTrace?: ResearchProcessingTrace) {
    const {input, metadata} = this.indexSource(document.id, parseId, data, suppliedTrace);
    this.research.knowledge.upsertFromSource(input, metadata, suppliedTrace);
    return input;
  }

  /** The same deterministic source plan is used before provider work and during publication. */
  indexSource(documentId: string, parseId: string, data: StoredDocumentContent, suppliedTrace?: ResearchProcessingTrace) {
    const document = this.get(documentId);
    const trace = suppliedTrace ?? this.research.processing.trace({trace_id: `library-index:${parseId}:${this.now()}`,
      paper_id: document.libraryItemId, document_id: document.id, parse_id: parseId, source_hash: document.sourceHash,
      parser_fingerprint: data.content.parserFingerprint});
    trace.bind({chunk_version: knowledgeChunkVersion});
    const chunks = indexDocumentBlocks(data.content.blocks, {paperId: document.libraryItemId, parseId, sourceHash: document.sourceHash}, trace,
      data.semanticEnrichment?.structure ?? data.content.structure);
    const input = { id: `document:${parseId}`, projectId: null as string | null, sourceType: 'file' as const, sourceId: document.libraryItemId,
      title: `${this.research.library.get(document.libraryItemId).metadata.title} — ${document.filename}`, content: data.content.content, chunks, embeddingPolicy: 'none' as const };
    return {input, metadata: {paperId: document.libraryItemId, documentId: document.id, parseId, sourceHash: document.sourceHash}};
  }

  publishPreparedIndex(documentId: string, parseId: string, data: StoredDocumentContent,
    prepared: PreparedKnowledgeEmbeddings, requireCurrent: () => void): void {
    this.db.transaction(() => {
      requireCurrent();
      const document = this.get(documentId);
      if (document.currentParseId !== parseId || document.activeParseId !== null) throw new Error('research_document_parse_stale');
      if (this.research.library.get(document.libraryItemId).archived) throw new Error('research_library_item_archived');
      const indexed = this.index(document, parseId, data);
      this.storePrepared(prepared);
      this.research.paperCards.enqueue(indexed.id);
    }).immediate();
    this.wakePublishedKnowledge();
  }

  private storePrepared(prepared: PreparedKnowledgeEmbeddings): void {
    if (prepared.identity) this.research.knowledge.storeChunkEmbeddings({configId: prepared.identity.configId,
      configRevision: prepared.identity.revision, chunks: prepared.chunks, vectors: prepared.vectors});
    else if (prepared.vectors.length) throw new Error('research_embedding_chunk_count_mismatch');
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
  const data = storedDocumentContentSchema.parse(value);
  if (data.scholarlyEnrichment) assertScholarlyEnrichment(data.scholarlyEnrichment, data.content.sourceHash, data.content.blocks);
  return data;
}
