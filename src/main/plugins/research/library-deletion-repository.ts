import type {Database} from 'better-sqlite3';
import {z} from 'zod';
import type {ResearchRepository} from './repository';
import type {AcquisitionClaim} from './literature-acquisition-repository';
import type {PdfPublication} from './pdf-download-service';
import {researchContentHash} from './research-files';
import {knowledgeId} from './index-repository';

const id = z.string().min(1);
const pdfSchema = z.strictObject({
  workspacePath: z.string().nullable(), relativePath: id, sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().positive(), temporaryPath: id.optional(), device: id.optional(), inode: id.optional()
});
const cleanupSchema = z.strictObject({
  documentIds: id.array(), parseScopes: id.array(), jobIds: id.array(), projectIds: id.array(), pdfs: pdfSchema.array(),
  knowledgeIds: id.array(), indexPaths: id.array().default([]), indexDocumentIds: id.array().default([])
});
export type LibraryCleanup = z.infer<typeof cleanupSchema>;

const keys = (json: string): string => `(SELECT value FROM json_each(${json}))`;

export class LibraryDeletionRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository) {}

  recordPublication(job: AcquisitionClaim, file: PdfPublication): void {
    this.db.prepare(`INSERT INTO research_library_pdf_publications
      (item_id,job_id,generation,workspace_path,relative_path,temporary_path,device,inode,sha256,bytes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(job.libraryItemId, job.id, job.generation, file.workspacePath, file.relativePath,
      file.temporaryPath, file.device, file.inode, file.sha256, file.bytes);
  }

  pendingIds(): string[] {
    return this.db.prepare('SELECT item_id FROM research_library_deletions ORDER BY rowid').pluck().all() as string[];
  }

  pending(id: string): LibraryCleanup | null {
    const json = this.db.prepare('SELECT cleanup_json FROM research_library_deletions WHERE item_id=?').pluck().get(id);
    return typeof json === 'string' ? cleanupSchema.parse(JSON.parse(json)) : null;
  }

  finish(id: string): void {
    this.db.prepare('DELETE FROM research_library_deletions WHERE item_id=?').run(id);
  }

  begin(id: string, revision: number): LibraryCleanup | null {
    return this.db.transaction(() => {
      const pending = this.pending(id);
      if (pending) return pending;
      if (this.db.prepare('SELECT 1 FROM research_library WHERE id=?').get(id) === undefined) return null;
      const item = this.research.library.get(id);
      if (item.revision !== revision) throw new Error('research_library_version_conflict');

      const documentIds = this.db.prepare('SELECT id FROM research_documents WHERE library_item_id=?').pluck().all(id) as string[];
      const documents = JSON.stringify(documentIds);
      const parses = this.db.prepare(`SELECT id,document_id AS documentId FROM research_document_parses
        WHERE document_id IN ${keys('?')}`).all(documents) as Array<{id: string; documentId: string}>;
      const knowledge = this.db.prepare(`SELECT id FROM research_knowledge_documents
        WHERE source_id=? AND source_type IN ('file','literature')`).pluck().all(id) as string[];
      // Old captures can outlive the index generation that originally supported them.
      const sources = [...new Set([id, ...documentIds, ...knowledge, `library:${id}`, ...parses.map(parse => `document:${parse.id}`)])];
      const evidence = this.db.prepare(`SELECT id,project_id FROM research_evidence
        WHERE (source_id=? AND source_type IN ('file','literature')) OR document_id IN ${keys('?')}`)
        .all(id, JSON.stringify(sources)) as Array<{id: string; project_id: string}>;
      const evidenceIds = new Set(evidence.map(row => row.id));
      const affectedProjects = this.db.prepare(`SELECT project_id FROM research_paper_extraction_jobs WHERE document_id IN ${keys('?')}
        UNION SELECT project_id FROM research_wiki_pages WHERE source_document_id IN ${keys('?')}`)
        .pluck().all(documents, JSON.stringify(sources)) as string[];
      const projectIds = [...new Set([...item.projectIds, ...affectedProjects, ...evidence.map(row => row.project_id),
        ...this.db.prepare(`SELECT DISTINCT project_id FROM research_paper_acquisition_jobs
          WHERE library_item_id=? AND project_id IS NOT NULL`).pluck().all(id) as string[]])];

      const cleanup = cleanupSchema.parse({
        documentIds, projectIds, knowledgeIds: knowledge,
        parseScopes: parses.map(parse => researchContentHash(`${parse.documentId}\n${parse.id}`)),
        jobIds: this.db.prepare('SELECT id FROM research_paper_acquisition_jobs WHERE library_item_id=?').pluck().all(id),
        pdfs: this.pdfs(id)
      });

      const cacheHashes = this.cacheHashes(knowledge, documents);
      const claims = this.research.evidence.detachDeletedPaperEvidence(evidenceIds);
      const wikiHashes = this.research.wiki.removePaperSources(new Set(sources), evidenceIds, claims);
      this.purgeDependentRows(id, documents, JSON.stringify([...evidenceIds]), JSON.stringify(knowledge));
      this.clearImportReferences(id);
      this.db.prepare('DELETE FROM research_library WHERE id=?').run(id);
      this.deleteCacheHashes([...cacheHashes, ...wikiHashes]);
      this.db.prepare('INSERT INTO research_library_deletions(item_id,cleanup_json) VALUES (?,?)').run(id, JSON.stringify(cleanup));
      return cleanup;
    }).immediate();
  }

  workspaceIndexProjects(root: string): string[] {
    return this.db.prepare('SELECT project_id FROM research_index_projects WHERE root_path=? OR workspace_path=? ORDER BY project_id')
      .pluck().all(root, root) as string[];
  }

  purgeWorkspaceIndex(itemId: string, root: string, path: string, sourceHash: string): void {
    this.db.transaction(() => {
      const cleanup = this.pending(itemId);
      if (cleanup === null) return;
      const files = this.db.prepare(`SELECT f.id,f.project_id,f.payload_json FROM research_index_files f
        JOIN research_index_projects p ON p.project_id=f.project_id
        WHERE f.path=? AND (p.root_path=? OR p.workspace_path=?)`).all(path, root, root) as
        Array<{id: string; project_id: string; payload_json: string | null}>;
      if (files.length === 0) return;
      const fileIds = JSON.stringify(files.map(file => file.id));
      const sources = files.map(file => knowledgeId(file.id));
      const sourceIds = JSON.stringify(sources);
      const cachedPaths = this.db.prepare(`SELECT DISTINCT cache_path FROM research_index_sources
        WHERE file_id IN ${keys('?')}`).pluck().all(fileIds) as string[];
      for (const {project_id} of files) cachedPaths.push(`sources/${project_id}/${sourceHash}/source.pdf`);
      const generations = this.db.prepare(`SELECT document_id,parse_id,
        json_extract(snapshot_json,'$.source.artifactId') AS artifactId FROM research_scientific_index_generations
        WHERE document_id IN ${keys('?')}`).all(sourceIds) as Array<{document_id: string; parse_id: string; artifactId: string | null}>;
      for (const generation of generations) {
        if (generation.artifactId && /^[a-f0-9]{64}$/u.test(generation.artifactId)) {
          cachedPaths.push(`artifacts/${generation.artifactId}`);
        }
        cachedPaths.push(`paper-ir/${researchContentHash(`${generation.document_id}\n${generation.parse_id}`)}`);
      }
      for (const file of files) {
        if (!file.payload_json) continue;
        const payload = JSON.parse(file.payload_json) as {artifactPath?: string; paperIR?: {identity: {parseId: string}}};
        if (payload.artifactPath) cachedPaths.push(payload.artifactPath);
        if (payload.paperIR) cachedPaths.push(`paper-ir/${researchContentHash(`${knowledgeId(file.id)}\n${payload.paperIR.identity.parseId}`)}`);
      }
      const evidence = this.db.prepare(`SELECT id FROM research_evidence WHERE document_id IN ${keys('?')}`).pluck().all(sourceIds) as string[];
      const evidenceIds = new Set(evidence);
      const cache = this.cacheHashes(sources, sourceIds);
      const claims = this.research.evidence.detachDeletedPaperEvidence(evidenceIds);
      const wiki = this.research.wiki.removePaperSources(new Set([...sources, ...files.map(file => file.id)]), evidenceIds, claims);
      this.purgeDependentRows(itemId, sourceIds, JSON.stringify(evidence), sourceIds);
      this.db.prepare(`DELETE FROM research_index_files WHERE id IN ${keys('?')}`).run(fileIds);
      this.deleteCacheHashes([...cache, ...wiki]);
      cleanup.indexPaths = [...new Set([...cleanup.indexPaths, ...cachedPaths])];
      cleanup.indexDocumentIds = [...new Set([...cleanup.indexDocumentIds, ...sources])];
      cleanup.projectIds = [...new Set([...cleanup.projectIds, ...files.map(file => file.project_id)])];
      this.db.prepare('UPDATE research_library_deletions SET cleanup_json=? WHERE item_id=?').run(JSON.stringify(cleanup), itemId);
    }).immediate();
  }

  isIndexPathShared(path: string): boolean {
    if (path.startsWith('artifacts/')) return this.research.indexing.referencedArtifacts().has(path.slice('artifacts/'.length));
    if (path.startsWith('paper-ir/')) {
      return this.db.prepare(`SELECT 1 FROM research_scientific_index_generations
        WHERE json_extract(snapshot_json,'$.paperIR.path') LIKE ? LIMIT 1`).get(`${path}/%`) !== undefined;
    }
    return this.db.prepare('SELECT 1 FROM research_index_sources WHERE cache_path=? LIMIT 1').get(path) !== undefined;
  }

  private deleteCacheHashes(hashes: string[]): void {
    this.db.prepare(`DELETE FROM research_embedding_cache WHERE input_hash IN ${keys('?')}
      AND NOT EXISTS (SELECT 1 FROM research_wiki_sections WHERE input_hash=research_embedding_cache.input_hash)`)
      .run(JSON.stringify([...new Set(hashes)]));
  }

  private pdfs(itemId: string): Array<z.infer<typeof pdfSchema>> {
    const published = this.db.prepare(`SELECT workspace_path AS workspacePath,relative_path AS relativePath,
      temporary_path AS temporaryPath,device,inode,sha256,bytes FROM research_library_pdf_publications WHERE item_id=?`)
      .all(itemId) as Array<z.infer<typeof pdfSchema>>;
    const legacy = this.db.prepare(`SELECT CASE WHEN j.project_id IS NULL THEN NULL ELSE p.workspace_path END AS workspacePath,
      r.relative_path AS relativePath,r.sha256,r.bytes
      FROM research_paper_download_receipts r JOIN research_paper_acquisition_jobs j ON j.id=r.job_id
      LEFT JOIN research_projects p ON p.id=j.project_id
      WHERE j.library_item_id=? AND r.relative_path IS NOT NULL AND (j.project_id IS NULL OR p.workspace_path IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM research_library_pdf_publications f
        WHERE f.item_id=j.library_item_id AND f.job_id=j.id AND f.relative_path=r.relative_path
          AND f.generation=r.generation AND f.sha256=r.sha256)`).all(itemId) as Array<z.infer<typeof pdfSchema>>;
    return [...published, ...legacy];
  }

  private cacheHashes(knowledge: string[], documents: string): string[] {
    const hashes = this.db.prepare(`SELECT DISTINCT embedding_text_hash FROM research_scientific_chunks
      WHERE document_id IN ${keys('?')} AND retrieval=1`).pluck().all(documents) as string[];
    for (const id of knowledge) {
      for (const chunk of this.research.knowledge.knowledgeChunks(id)) {
        hashes.push(researchContentHash(chunk.embeddingInput));
      }
    }
    return hashes;
  }

  private purgeDependentRows(itemId: string, documents: string, evidence: string, knowledge: string): void {
    const db = this.db;
    const documentIds = keys('@documents'), evidenceIds = keys('@evidence');
    db.prepare(`DELETE FROM research_source_replacements WHERE evidence_id IN ${evidenceIds} OR target_evidence_id IN ${evidenceIds}`).run({evidence});
    const proposals = `SELECT id FROM research_source_migration_proposals
      WHERE document_id IN ${documentIds} OR evidence_id IN ${evidenceIds}`;
    db.prepare(`DELETE FROM research_source_migration_decisions WHERE proposal_id IN (${proposals})`).run({documents, evidence});
    db.prepare(`DELETE FROM research_source_migration_proposals WHERE id IN (${proposals})`).run({documents, evidence});
    db.prepare(`DELETE FROM research_document_annotation_captures WHERE evidence_id IN ${evidenceIds}
      OR annotation_id IN (SELECT id FROM research_document_annotations WHERE document_id IN ${documentIds})`).run({documents, evidence});
    db.prepare(`DELETE FROM research_document_annotations WHERE document_id IN ${documentIds}`).run({documents});
    db.prepare(`DELETE FROM research_evidence_relations WHERE evidence_id IN ${evidenceIds}`).run({evidence});
    db.prepare(`DELETE FROM research_provenance WHERE (source_id=@itemId AND source_type IN ('file','literature'))
      OR source_id IN ${documentIds} OR source_id IN ${evidenceIds}`).run({itemId, documents, evidence});
    db.prepare(`DELETE FROM research_evidence WHERE id IN ${evidenceIds}`).run({evidence});

    db.prepare(`DELETE FROM research_reading_highlights WHERE document_id IN ${documentIds}`).run({documents});
    db.prepare("DELETE FROM research_reading_notes WHERE json_extract(snapshot_json,'$.itemId')=?").run(itemId);
    db.prepare("UPDATE research_radar_articles SET snapshot_json=json_set(snapshot_json,'$.importedItemId',NULL) WHERE json_extract(snapshot_json,'$.importedItemId')=?").run(itemId);
    db.prepare("DELETE FROM research_resource_associations WHERE target_kind='literature' AND target_id=?").run(itemId);
    // A review can retain its signed history and attach a new source. The old
    // binding no longer owns or resolves a local document.
    db.prepare(`UPDATE research_review_fulltext_bindings SET document_id=NULL WHERE document_id IN ${documentIds}`).run({documents});

    const extraction = `SELECT id FROM research_paper_extraction_jobs WHERE document_id IN ${documentIds}`;
    db.prepare(`DELETE FROM research_paper_entity_aliases WHERE EXISTS (
      SELECT 1 FROM research_paper_entities e JOIN research_paper_extraction_jobs j ON j.id=e.generation_id
      WHERE e.id=target_entity_id AND j.project_id=research_paper_entity_aliases.project_id AND j.id IN (${extraction}))
      AND NOT EXISTS (SELECT 1 FROM research_paper_entities e JOIN research_paper_extraction_jobs j ON j.id=e.generation_id
      WHERE e.id=target_entity_id AND j.project_id=research_paper_entity_aliases.project_id AND j.id NOT IN (${extraction}))`).run({documents});
    db.prepare(`DELETE FROM research_paper_extraction_jobs WHERE id IN (${extraction})`).run({documents});
    db.prepare(`DELETE FROM research_scientific_index_generations WHERE document_id IN ${documentIds}`).run({documents});
    db.prepare(`DELETE FROM research_paper_cards WHERE document_id IN ${documentIds} OR knowledge_id IN ${keys('@knowledge')}`).run({documents, knowledge});
    db.prepare(`DELETE FROM research_knowledge_documents WHERE id IN ${keys('?')}`).run(knowledge);

    this.purgeZotero(itemId, documents);
    const monitors = `SELECT monitor_id FROM research_monitor_versions WHERE json_extract(snapshot_json,'$.query.itemId')=?`;
    db.prepare(`DELETE FROM research_monitor_alerts WHERE monitor_id IN (${monitors})`).run(itemId);
    db.prepare(`DELETE FROM research_monitor_seen WHERE monitor_id IN (${monitors})`).run(itemId);
    db.prepare(`DELETE FROM research_monitors WHERE id IN (${monitors})`).run(itemId);
  }

  private purgeZotero(itemId: string, documents: string): void {
    const objects = `(server_id,library_kind,library_id,item_key) IN (
      SELECT server_id,library_kind,library_id,item_key FROM research_zotero_objects WHERE item_id=@itemId)`;
    const inspections = `SELECT id FROM research_zotero_attachment_inspections WHERE ${objects}`;
    const grants = `SELECT id FROM research_zotero_attachment_grants WHERE inspection_id IN (${inspections})`;
    this.db.prepare(`DELETE FROM research_zotero_attachment_imports WHERE document_id IN ${keys('@documents')}
      OR grant_id IN (${grants})`).run({itemId, documents});
    this.db.prepare(`DELETE FROM research_zotero_attachment_grants WHERE id IN (${grants})`).run({itemId});
    for (const table of ['research_zotero_attachment_inspections', 'research_zotero_source_states',
      'research_zotero_import_observations', 'research_zotero_object_versions', 'research_zotero_objects']) {
      this.db.prepare(`DELETE FROM ${table} WHERE ${objects}`).run({itemId});
    }
  }

  private clearImportReferences(itemId: string): void {
    const aliases = `SELECT identity FROM research_library_aliases WHERE item_id=@itemId
      UNION SELECT identity_key FROM research_library WHERE id=@itemId`;
    const match = `json_extract(entry.value,'$.libraryItemId')=@itemId
      OR json_extract(entry.value,'$.entryKey') IN (${aliases})`;
    this.db.prepare(`UPDATE research_literature_imports SET cancel_requested=1
      WHERE json_extract(result_json,'$.status') IN ('queued','running')
      AND EXISTS (SELECT 1 FROM json_each(result_json,'$.items') entry WHERE ${match})`).run({itemId});
    const rows = this.db.prepare(`SELECT i.id,entry.key AS position FROM research_literature_imports i,
      json_each(i.result_json,'$.items') entry WHERE ${match}`).all({itemId}) as Array<{id: string; position: number}>;
    for (const row of rows) {
      const path = `$.items[${row.position}]`;
      this.db.prepare(`UPDATE research_literature_imports SET frozen_json=json_set(frozen_json,?,NULL),
        result_json=json_remove(json_set(result_json,?,'deleted',?,NULL,?,NULL),?)
        WHERE id=?`).run(`$[${row.position}]`, `${path}.entryKey`, `${path}.libraryItemId`,
          `${path}.citationKey`, `${path}.citationKeyMapping`, row.id);
    }
  }
}
