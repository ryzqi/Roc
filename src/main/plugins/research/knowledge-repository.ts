import { createHash } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import { researchKnowledgeDocumentSchema } from '../../../shared/schemas/research';
import type {
  ResearchEmbeddingConfigSaveRequest,
  ResearchKnowledgeDocument,
  ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchHit,
  ResearchKnowledgeSearchRequest,
  ResearchKnowledgeSearchResult
} from '../../../shared/types';
import { normalizeEmbeddingBlob } from './embedding-vectors';

export type KnowledgeEmbeddingPolicy = 'selected' | 'none';
export type KnowledgeSourceWrite = {
  id: string;
  projectId: string | null;
  sourceType: 'literature' | 'file' | 'note' | 'experiment';
  sourceId: string;
  title: string;
  content: string;
  chunks: Array<{ content: string; locator: string | null }>;
  embeddingPolicy: KnowledgeEmbeddingPolicy;
};

type Clock = () => string;

export type EmbeddingConfigRow = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  dimensions: number;
  api_key_secret_key: string;
  enabled: number;
  updated_at: string;
  revision: number;
};

type KnowledgeHitRow = {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  locator: string | null;
  source_type: string;
  source_id: string;
};

export class ResearchKnowledgeRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly requireProject: (id: string) => void,
    private readonly now: Clock
  ) {}

  saveEmbeddingConfig(request: ResearchEmbeddingConfigSaveRequest, apiKeySecretKey: string): void {
    /**
     * 维度在这里是最后一道门：`null` 表示「保存前还没探测到」。
     *
     * 列是 `NOT NULL`，而插一个猜的默认值会把错误推到索引时才暴露。服务层的 `saveConfig`
     * 会先把 `null` 探成真实数字再进来，所以能走到这里的 `null` 是调用方漏了一步。
     */
    if (request.dimensions === null) {
      throw new Error('research_embedding_dimensions_required');
    }
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO research_embedding_configs
         (id, name, base_url, model, dimensions, api_key_secret_key, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           revision = CASE WHEN base_url <> excluded.base_url OR model <> excluded.model OR dimensions <> excluded.dimensions
             OR api_key_secret_key <> excluded.api_key_secret_key OR enabled <> excluded.enabled THEN revision + 1 ELSE revision END,
           name = excluded.name,
           base_url = excluded.base_url,
           model = excluded.model,
           dimensions = excluded.dimensions,
           api_key_secret_key = excluded.api_key_secret_key,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`
      )
      .run(
        request.id,
        request.name,
        request.baseUrl.replace(/\/+$/, ''),
        request.model,
        request.dimensions,
        apiKeySecretKey,
        request.enabled ? 1 : 0,
        timestamp,
        timestamp
      );
  }

  listEmbeddingConfigRows(): EmbeddingConfigRow[] {
    return this.db
      .prepare(
        `SELECT id, name, base_url, model, dimensions, api_key_secret_key, enabled, updated_at, revision
         FROM research_embedding_configs ORDER BY updated_at DESC`
      )
      .all() as EmbeddingConfigRow[];
  }

  upsertFromSource(input: KnowledgeSourceWrite, sourceMetadata: Record<string, unknown> = {}): ResearchKnowledgeDocument {
    if (input.embeddingPolicy !== 'none' && input.embeddingPolicy !== 'selected') {
      throw new Error('research_knowledge_embedding_policy_invalid');
    }
    if (input.embeddingPolicy === 'selected') throw new Error('research_knowledge_selected_requires_embedding_service');
    const { embeddingPolicy: _policy, ...fields } = input;
    return this.upsertKnowledgeDocument({ ...fields, embeddingConfigId: null }, sourceMetadata);
  }

  upsertKnowledgeDocument(request: ResearchKnowledgeDocumentUpsertRequest, sourceMetadata: Record<string, unknown> = {}): ResearchKnowledgeDocument {
    if (request.projectId !== null) this.requireProject(request.projectId);
    const existing = this.db.prepare('SELECT project_id FROM research_knowledge_documents WHERE id = ?').get(request.id) as { project_id: string | null } | undefined;
    if (existing !== undefined && existing.project_id !== request.projectId) throw new Error('research_knowledge_project_mismatch');
    const timestamp = this.now();
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO research_knowledge_documents
           (id, project_id, source_type, source_id, title, content, metadata_json, content_hash, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             source_type = excluded.source_type,
             source_id = excluded.source_id,
             title = excluded.title,
             content = excluded.content,
             metadata_json = excluded.metadata_json,
             content_hash = excluded.content_hash,
             indexed_at = excluded.indexed_at`
        )
        .run(request.id, request.projectId, request.sourceType, request.sourceId, request.title, request.content, JSON.stringify(sourceMetadata), hashText(request.content), timestamp);
      this.db.prepare('DELETE FROM research_knowledge_chunks WHERE document_id = ?').run(request.id);
      const insertChunk = this.db.prepare(
        `INSERT INTO research_knowledge_chunks
         (id, document_id, project_id, chunk_index, content, locator, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      request.chunks.forEach((chunk, index) => {
        insertChunk.run(`${request.id}:chunk:${index}`, request.id, request.projectId, index, chunk.content, chunk.locator, hashText(chunk.content), timestamp);
      });
    });
    write();
    return { id: request.id, projectId: request.projectId, sourceType: request.sourceType, sourceId: request.sourceId,
      title: request.title, content: request.content, indexedAt: timestamp };
  }

  requireEmbeddingConfig(id: string, revision: number): EmbeddingConfigRow {
    const row = this.listEmbeddingConfigRows().find((entry) => entry.id === id);
    if (row === undefined) throw new Error('research_embedding_config_not_found');
    if (row.revision !== revision) throw new Error('research_embedding_config_changed');
    if (row.enabled !== 1) throw new Error('research_embedding_config_disabled');
    return row;
  }

  knowledgeChunks(documentId: string): Array<{ id: string; content: string; contentHash: string }> {
    return this.db.prepare('SELECT id,content,content_hash AS contentHash FROM research_knowledge_chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(documentId) as Array<{ id: string; content: string; contentHash: string }>;
  }

  knowledgeDocument(id: string): ResearchKnowledgeDocument {
    const row = this.db.prepare(`SELECT id,project_id AS projectId,source_type AS sourceType,source_id AS sourceId,title,content,indexed_at AS indexedAt
      FROM research_knowledge_documents WHERE id = ?`).get(id);
    if (row === undefined) throw new Error('research_knowledge_document_not_found');
    return researchKnowledgeDocumentSchema.parse(row);
  }

  storeChunkEmbeddings(input: { configId: string; configRevision: number; chunks: readonly { id: string; contentHash: string }[]; vectors: readonly Buffer[] }): void {
    if (input.chunks.length !== input.vectors.length || new Set(input.chunks.map((chunk) => chunk.id)).size !== input.chunks.length) {
      throw new Error('research_embedding_chunk_count_mismatch');
    }
    const write = this.db.transaction(() => {
      const config = this.requireEmbeddingConfig(input.configId, input.configRevision);
      const vectors: Buffer[] = [];
      for (const [index, chunk] of input.chunks.entries()) {
        const current = this.db.prepare('SELECT content_hash FROM research_knowledge_chunks WHERE id = ?').get(chunk.id) as { content_hash: string } | undefined;
        if (current === undefined || current.content_hash !== chunk.contentHash) throw new Error('research_embedding_source_changed');
        vectors.push(normalizeEmbeddingBlob(input.vectors[index], config.dimensions));
      }
      const statement = this.db.prepare(
        `INSERT INTO research_knowledge_embeddings (chunk_id, space_key, dimensions, vector_blob, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id, space_key) DO UPDATE SET
           dimensions = excluded.dimensions,
           vector_blob = excluded.vector_blob,
           created_at = excluded.created_at`
      );
      input.chunks.forEach((chunk, index) => statement.run(chunk.id, embeddingSpaceKey(config.id, config.revision), config.dimensions, vectors[index], this.now()));
    });
    write();
  }

  searchKnowledge(input: {
    request: ResearchKnowledgeSearchRequest;
    vector: { configId: string; configRevision: number; blob: Buffer } | null;
  }): ResearchKnowledgeSearchResult {
    const keywordHits = this.keywordSearch(input.request.query, input.request.projectId, input.request.limit);
    const config = input.vector === null ? null : this.requireEmbeddingConfig(input.vector.configId, input.vector.configRevision);
    const vectorHits = input.vector === null || config === null ? [] : this.vectorSearch(input.request.projectId, input.request.limit,
      { spaceKey: embeddingSpaceKey(config.id, config.revision), dimensions: config.dimensions, blob: input.vector.blob });
    const merged = new Map<string, ResearchKnowledgeSearchHit>();
    keywordHits.forEach((hit, index) => {
      merged.set(hit.chunkId, { ...hit, keywordRank: index + 1, vectorRank: null, rrfScore: 1 / (60 + index + 1) });
    });
    vectorHits.forEach((hit, index) => {
      const existing = merged.get(hit.chunkId);
      const vectorScore = 1 / (60 + index + 1);
      if (existing === undefined) {
        merged.set(hit.chunkId, { ...hit, keywordRank: null, vectorRank: index + 1, rrfScore: vectorScore });
      } else {
        existing.vectorRank = index + 1;
        existing.rrfScore += vectorScore;
      }
    });
    const hits = Array.from(merged.values())
      .sort((left, right) => right.rrfScore - left.rrfScore)
      .slice(0, input.request.limit);
    return {
      query: input.request.query,
      hits,
      keywordCount: keywordHits.length,
      vectorCount: vectorHits.length,
      embeddingModel: config?.model ?? null,
      generatedAt: this.now()
    };
  }

  private keywordSearch(query: string, projectId: string | null, limit: number): ResearchKnowledgeSearchHit[] {
    const match = query
      .split(/\s+/u)
      .map((term) => term.replace(/"/gu, ''))
      .filter((term) => term.length > 0)
      .map((term) => `"${term}"`)
      .join(' OR ');
    if (match.length === 0) return [];
    const projectClause = projectId === null ? '' : 'AND (d.project_id = ? OR d.project_id IS NULL)';
    const args = projectId === null ? [match, limit] : [match, projectId, limit];
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.document_id, d.title, c.content, c.locator,
                d.source_type, d.source_id
         FROM research_knowledge_documents_fts f
         JOIN research_knowledge_documents d ON d.rowid = f.rowid
         JOIN research_knowledge_chunks c ON c.document_id = d.id
         WHERE research_knowledge_documents_fts MATCH ? ${projectClause}
         ORDER BY bm25(research_knowledge_documents_fts) ASC LIMIT ?`
      )
      .all(...args) as KnowledgeHitRow[];
    return rows.map((row) => toKnowledgeHit(row));
  }

  private vectorSearch(
    projectId: string | null,
    limit: number,
    vector: { spaceKey: string; dimensions: number; blob: Buffer }
  ): ResearchKnowledgeSearchHit[] {
    const blob = normalizeEmbeddingBlob(vector.blob, vector.dimensions);
    const projectJoin = projectId === null ? '' : 'JOIN research_knowledge_chunks scoped ON scoped.id = e.chunk_id';
    const projectClause = projectId === null ? '' : 'AND (scoped.project_id = ? OR scoped.project_id IS NULL)';
    // Rank narrow vector rows first; hydrate document text only for the selected hits.
    // MATERIALIZED keeps SQLite from flattening the joins back into the full scan.
    const args = projectId === null
      ? [blob, vector.spaceKey, vector.dimensions, limit]
      : [blob, vector.spaceKey, vector.dimensions, projectId, limit];
    const rows = this.db
      .prepare(
        `WITH nearest AS MATERIALIZED (
           SELECT e.chunk_id, vec_distance_cosine(e.vector_blob, ?) AS distance
           FROM research_knowledge_embeddings e
           ${projectJoin}
           WHERE e.space_key = ? AND e.dimensions = ? ${projectClause}
           ORDER BY distance ASC LIMIT ?
         )
         SELECT nearest.chunk_id, c.document_id, d.title, c.content, c.locator,
                d.source_type, d.source_id
         FROM nearest
         JOIN research_knowledge_chunks c ON c.id = nearest.chunk_id
         JOIN research_knowledge_documents d ON d.id = c.document_id
         ORDER BY nearest.distance ASC`
      )
      .all(...args) as KnowledgeHitRow[];
    return rows.map((row) => toKnowledgeHit(row));
  }
}

function toKnowledgeHit(row: KnowledgeHitRow): ResearchKnowledgeSearchHit {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    content: row.content,
    locator: row.locator,
    sourceType: row.source_type,
    sourceId: row.source_id,
    keywordRank: null,
    vectorRank: null,
    rrfScore: 0
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function embeddingSpaceKey(id: string, revision: number): string {
  return `embedding:${id}:${revision}`;
}
