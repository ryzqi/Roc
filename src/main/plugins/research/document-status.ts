import type {Database} from 'better-sqlite3';
import {isDeepStrictEqual} from 'node:util';
import {
  researchDocumentStatusRequestSchema, researchDocumentStatusResultSchema,
  type ResearchDocumentStatusRequest, type ResearchDocumentStatusResult
} from '../../../shared/schemas/research-document-status';
import {researchDocumentSchema} from '../../../shared/schemas/research-documents';
import type {ResearchRepository} from './repository';
import {researchContentHash} from './research-files';
import {scientificEmbeddingIdentitySchema, type ScientificEmbeddingIdentity} from './scientific-index-repository';

type IndexStatus = ResearchDocumentStatusResult['items'][number]['documents'][number]['indexStatus'];
type StatusRow = {
  id: string; library_item_id: string; status: string; source_hash: string; current_parse_id: string | null;
  error: string | null; archived: number; job_status: string | null; job_error: string | null;
  generation_id: string | null; generation_count: number;
  knowledge_id: string | null; knowledge_project_id: string | null; knowledge_source_type: string | null;
  knowledge_source_id: string | null; knowledge_content_hash: string | null; knowledge_metadata: string | null;
};
const invalidIndex = '索引记录或向量不完整，请重建索引。';

/**
 * Batch the cheap ownership, document and outbox reads. Only a potentially usable current index
 * incurs its existing full validators; this endpoint never parses, calls a provider or rewrites data.
 */
export function readResearchDocumentStatuses(db: Database, repository: ResearchRepository,
  input: ResearchDocumentStatusRequest): ResearchDocumentStatusResult {
  const request = researchDocumentStatusRequestSchema.parse(input), ids = JSON.stringify(request.libraryItemIds);
  return db.transaction(() => {
    if (request.projectId !== null) repository.getProject(request.projectId);
    const owned = db.prepare(`SELECT l.id,
      (? IS NULL OR EXISTS (SELECT 1 FROM research_library_projects p WHERE p.item_id=l.id AND p.project_id=?)) AS linked
      FROM research_library l JOIN json_each(?) requested ON requested.value=l.id`)
      .all(request.projectId, request.projectId, ids) as Array<{id: string; linked: number}>;
    if (owned.length !== request.libraryItemIds.length) throw new Error('research_library_item_not_found');
    if (owned.some(item => item.linked !== 1)) throw new Error('research_document_project_mismatch');

    const rows = db.prepare(`SELECT d.id,d.library_item_id,d.status,d.source_hash,d.current_parse_id,d.error,l.archived,
      j.status AS job_status,j.error AS job_error,
      k.id AS knowledge_id,k.project_id AS knowledge_project_id,k.source_type AS knowledge_source_type,
      k.source_id AS knowledge_source_id,k.content_hash AS knowledge_content_hash,k.metadata_json AS knowledge_metadata,
      (SELECT g.id FROM research_scientific_index_generations g
        WHERE g.project_id IS NULL AND g.document_id=d.id AND g.status='active' ORDER BY g.id LIMIT 1) AS generation_id,
      (SELECT COUNT(*) FROM research_scientific_index_generations g
        WHERE g.project_id IS NULL AND g.document_id=d.id AND g.status='active') AS generation_count
      FROM research_documents d JOIN json_each(?) requested ON requested.value=d.library_item_id
      JOIN research_library l ON l.id=d.library_item_id
      LEFT JOIN research_knowledge_documents k ON k.id='document:'||d.current_parse_id
      LEFT JOIN research_knowledge_jobs j ON j.document_id='document:'||d.current_parse_id
      ORDER BY d.library_item_id,d.created_at,d.id`).all(ids) as StatusRow[];
    const selected = selectedEmbedding(repository);
    const byItem = new Map(request.libraryItemIds.map(libraryItemId => [libraryItemId, {
      libraryItemId, documents: [] as ResearchDocumentStatusResult['items'][number]['documents']
    }]));
    for (const row of rows) {
      const observed = indexState(repository, row, selected);
      byItem.get(row.library_item_id)!.documents.push({
        id: row.id, status: researchDocumentSchema.shape.status.parse(row.status), currentParseId: row.current_parse_id,
        indexStatus: observed.status, error: row.error ?? observed.error
      });
    }
    return researchDocumentStatusResultSchema.parse({items: request.libraryItemIds.map(id => byItem.get(id)!)});
  })();
}

function selectedEmbedding(repository: ResearchRepository): ScientificEmbeddingIdentity | null {
  const config = repository.knowledge.listEmbeddingConfigRows().find(row => row.enabled === 1);
  return config === undefined ? null : scientificEmbeddingIdentitySchema.parse({
    configId: config.id, revision: config.revision, model: config.model, dimensions: config.dimensions
  });
}

function indexState(repository: ResearchRepository, row: StatusRow, selected: ScientificEmbeddingIdentity | null):
  {status: IndexStatus; error: string | null} {
  if (row.archived === 1 || row.current_parse_id === null) return {status: 'unavailable', error: null};
  if (row.job_status === 'queued' || row.job_status === 'running') return {status: row.job_status, error: null};
  if (row.job_status === 'failed') return {status: 'failed', error: row.job_error ?? invalidIndex};
  if (selected === null || row.job_status === 'blocked') return {status: 'unavailable', error: row.job_error};
  if (row.generation_id === null) return {status: 'unavailable', error: null};
  if (row.generation_count !== 1) return {status: 'failed', error: invalidIndex};
  try {
    const generation = repository.scientificIndex.get(row.generation_id), snapshot = generation.snapshot;
    const {data} = repository.documents.parsed(row.id, row.current_parse_id);
    const identity = snapshot.paperIR.identity;
    if (generation.status !== 'active' || snapshot.projectId !== null || snapshot.source.kind !== 'library' ||
      identity.documentId !== row.id || identity.paperId !== row.library_item_id ||
      identity.parseId !== row.current_parse_id || identity.sourceHash !== row.source_hash ||
      data.content.sourceHash !== row.source_hash || researchContentHash(JSON.stringify(data.content)) !== identity.parseHash ||
      !isDeepStrictEqual(data.paperIR, snapshot.paperIR)) return {status: 'failed', error: invalidIndex};
    if (!isDeepStrictEqual(snapshot.embedding, selected)) return {status: 'unavailable', error: null};
    const metadata = row.knowledge_metadata === null ? null : JSON.parse(row.knowledge_metadata) as Record<string, unknown>;
    if (row.knowledge_id !== `document:${row.current_parse_id}` || row.knowledge_project_id !== null ||
      row.knowledge_source_type !== 'file' || row.knowledge_source_id !== row.library_item_id ||
      row.knowledge_content_hash !== researchContentHash(data.content.content) || metadata?.paperId !== row.library_item_id ||
      metadata.documentId !== row.id || metadata.parseId !== row.current_parse_id || metadata.sourceHash !== row.source_hash) {
      return {status: 'failed', error: invalidIndex};
    }
    if (!repository.knowledge.hasDocumentEmbeddings(`document:${row.current_parse_id}`, selected.configId, selected.revision)) {
      return {status: 'failed', error: invalidIndex};
    }
    repository.scientificIndex.verify(generation.id);
    return {status: 'ready', error: null};
  } catch {
    return {status: 'failed', error: invalidIndex};
  }
}
