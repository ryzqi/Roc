import {paperChunkSchema, type PaperChunk} from '../../../shared/schemas/research-paper-ir';
import {scientificRole} from './paper-ir';
import {routeScientificQuery, selectDiverse} from './query-routing';
import type {RerankerReceipt} from '../../../shared/schemas/research-reranker';
import {structuredSpans, spanLocator, knowledgeChunkVersion, chunkTokenCount} from './knowledge-chunks';
import {keywordTextV1,keywordQueryV1} from './knowledge-keywords';
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
import {knowledgeContextRequestSchema, type KnowledgeContextRequest} from '../../../shared/schemas/research-knowledge-context';

export type KnowledgeEmbeddingPolicy = 'selected' | 'none';
export type KnowledgeSourceWrite = {
  id: string;
  projectId: string | null;
  sourceType: 'literature' | 'file' | 'note' | 'experiment';
  sourceId: string;
  title: string;
  content: string;
  chunks: Array<{ content: string; locator: string | null; section?: string | null; semantic?: PaperChunk }>;
  embeddingPolicy: KnowledgeEmbeddingPolicy;
};

type Clock = () => string;
type KnowledgeVersionDocument = {document_hash:string;document_project:string|null;title:string;source_type:string;source_id:string;metadata_json:string};

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
      const keywordIndex = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_knowledge_keywords'").get()
        ? this.db.prepare('INSERT INTO research_knowledge_keywords(rowid,content,title) VALUES (?,?,?)') : null;
      const structure = this.db.prepare('INSERT INTO research_knowledge_chunk_structure VALUES (?,?,?,?,?)');
      const semantics = this.db.prepare('INSERT INTO research_knowledge_chunk_semantics VALUES (?,?)');
      const insert = (index: number, content: string, locator: string | null): string => {
        const id = `${request.id}:chunk:${index}`;
        const inserted = insertChunk.run(id, request.id, request.projectId, index, content, locator, hashText(content), timestamp);
        keywordIndex?.run(inserted.lastInsertRowid, keywordTextV1(content), keywordTextV1(request.title));
        return id;
      };
      // Preserve original parent IDs for annotation and historical evidence; only children are retrieved.
      request.chunks.forEach((chunk, index) => insert(index, chunk.content, chunk.locator));
      let childIndex = request.chunks.length;
      request.chunks.forEach((chunk, index) => {
        const parentId = `${request.id}:chunk:${index}`;
        const spans = structuredSpans(chunk.content, chunk.section ?? null);
        const section = chunk.section ?? spans[0]?.section ?? null;
        const semantic = paperChunkSchema.parse(chunk.semantic ?? {paperId: request.id,
          parseId: typeof sourceMetadata.parseId === 'string' ? sourceMetadata.parseId : null,
          sourceHash: typeof sourceMetadata.sourceHash === 'string' ? sourceMetadata.sourceHash : hashText(request.content),
          blockId: parentId, sectionPath: section?.split(' / ') ?? [], semanticRole: scientificRole(section),
          blockKind: 'paragraph', relatedBlockIds: []});
        structure.run(parentId, null, 0, chunk.content.length, section);
        semantics.run(parentId, JSON.stringify(semantic));
        if (spans.length > 1) for (const span of spans) {
          const content = chunk.content.slice(span.start, span.end);
          if (!content.trim()) continue;
          const id = insert(childIndex++, content, spanLocator(chunk.locator, span));
          structure.run(id, parentId, span.start, span.end, span.section);
          semantics.run(id, JSON.stringify({...semantic, sectionPath: span.section?.split(' / ') ?? semantic.sectionPath,
            semanticRole: scientificRole(span.section) === 'unknown' ? semantic.semanticRole : scientificRole(span.section)}));
        }
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

  knowledgeChunks(documentId: string): Array<{id: string; content: string; contentHash: string; embeddingInput: string; inputVersion: string}> {
    const rows = this.db.prepare(`SELECT c.id,c.content,c.content_hash AS contentHash,s.section,d.title
      FROM research_knowledge_chunks c JOIN research_knowledge_documents d ON d.id=c.document_id
      LEFT JOIN research_knowledge_chunk_structure s ON s.chunk_id=c.id WHERE c.document_id=?
      AND NOT EXISTS (SELECT 1 FROM research_knowledge_chunk_structure child WHERE child.parent_chunk_id=c.id)
      ORDER BY c.chunk_index`).all(documentId) as Array<{id: string; content: string; contentHash: string; section: string | null; title: string}>;
    const budget = (text: string): string => {
      let value = [...text].slice(0, 400).join('');
      while (chunkTokenCount(value) > 128) value = [...value].slice(0, Math.floor([...value].length * 0.75)).join('');
      return value;
    };
    return rows.map(({title, section, ...chunk}) => ({...chunk, inputVersion: knowledgeChunkVersion,
      embeddingInput: `Document: ${budget(title)}\nRole: ${this.chunkSemantic(chunk.id)?.semanticRole ?? 'unknown'}\n${section ? `Section: ${budget(section)}\n` : ''}Text:\n${chunk.content}`}));
  }

  /** Read bounded original parent context. Partial text is not a new evidence identity. */
  chunkContext(projectId: string, chunkId: string, maxChars = 6000): {
    chunkId: string; parentChunkId: string; content: string; locator: string | null; start: number; end: number; totalChars: number; indexedVersion: string
  } {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 8000) throw new Error('research_knowledge_context_budget');
    this.requireProject(projectId);
    this.indexedVersion(chunkId, projectId, new Map());
    const relation = this.db.prepare('SELECT parent_chunk_id,start_utf16,end_utf16 FROM research_knowledge_chunk_structure WHERE chunk_id=?')
      .get(chunkId) as {parent_chunk_id: string | null; start_utf16: number; end_utf16: number} | undefined;
    const parentChunkId = relation?.parent_chunk_id ?? chunkId;
    const version = this.indexedVersion(parentChunkId, projectId, new Map());
    const parent = this.db.prepare('SELECT content,locator FROM research_knowledge_chunks WHERE id=?').get(parentChunkId) as {content: string; locator: string | null};
    if (relation?.parent_chunk_id) {
      const child = this.db.prepare('SELECT content,locator,document_id FROM research_knowledge_chunks WHERE id=?').get(chunkId) as {content: string; locator: string; document_id: string};
      const parentDocument = this.db.prepare('SELECT document_id FROM research_knowledge_chunks WHERE id=?').pluck().get(parentChunkId);
      if (parentDocument !== child.document_id || relation.end_utf16 > parent.content.length ||
          parent.content.slice(relation.start_utf16, relation.end_utf16) !== child.content ||
          child.locator !== spanLocator(parent.locator, {start: relation.start_utf16, end: relation.end_utf16})) {
        throw new Error('research_knowledge_source_corrupt');
      }
    }
    let start = Math.max(0, Math.min((relation?.start_utf16 ?? 0) - Math.floor(maxChars / 4), parent.content.length - maxChars));
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(parent.content[start]!)) start++;
    let end = Math.min(start + maxChars, parent.content.length);
    if (end < parent.content.length && /[\uD800-\uDBFF]/u.test(parent.content[end - 1]!)) end--;
    return {chunkId, parentChunkId, content: parent.content.slice(start, end), locator: parent.locator, start, end,
      totalChars: parent.content.length, indexedVersion: version.indexedVersion};
  }

  readContext(input: KnowledgeContextRequest) {
    const request = knowledgeContextRequestSchema.parse(input);
    this.requireProject(request.projectId);
    const version = this.indexedVersion(request.chunkId, request.projectId, new Map());
    if (version.indexedVersion !== request.expectedIndexedVersion) throw new Error('research_knowledge_source_changed');
    const main = this.chunkContext(request.projectId, request.chunkId, request.neighbors ? Math.floor(request.maxChars * 0.6) : request.maxChars);
    const adjacent = request.neighbors ? this.db.prepare(`SELECT c.id FROM research_knowledge_chunks c
      JOIN research_knowledge_chunk_structure s ON s.chunk_id=c.id
      WHERE c.document_id=? AND s.parent_chunk_id IS NULL AND c.id<>?
      AND ABS(c.chunk_index-(SELECT chunk_index FROM research_knowledge_chunks WHERE id=?))=1
      ORDER BY c.chunk_index`).all(version.documentId, main.parentChunkId, main.parentChunkId) as Array<{id: string}> : [];
    const budget = Math.floor((request.maxChars - main.content.length) / Math.max(1, adjacent.length));
    return {derived: false as const, context: main,
      neighbors: adjacent.map(row => this.chunkContext(request.projectId, row.id, budget))};
  }

  knowledgeDocument(id: string): ResearchKnowledgeDocument {
    const row = this.db.prepare(`SELECT id,project_id AS projectId,source_type AS sourceType,source_id AS sourceId,title,content,indexed_at AS indexedAt
      FROM research_knowledge_documents WHERE id = ?`).get(id);
    if (row === undefined) throw new Error('research_knowledge_document_not_found');
    return researchKnowledgeDocumentSchema.parse(row);
  }

  storeChunkEmbeddings(input: { configId: string; configRevision: number; chunks: readonly { id: string; contentHash: string; embeddingInput?: string; inputVersion?: string }[]; vectors: readonly Buffer[]; cache?: {version:string; hashes:readonly string[]} }): void {
    if (input.chunks.length !== input.vectors.length || new Set(input.chunks.map((chunk) => chunk.id)).size !== input.chunks.length) {
      throw new Error('research_embedding_chunk_count_mismatch');
    }
    const write = this.db.transaction(() => {
      const config = this.requireEmbeddingConfig(input.configId, input.configRevision);
      const vectors: Buffer[] = [];
      const currentInputs = new Map<string, Map<string, {embeddingInput: string; inputVersion: string}>>();
      for (const [index, chunk] of input.chunks.entries()) {
        const current = this.db.prepare('SELECT content_hash,document_id FROM research_knowledge_chunks WHERE id = ?').get(chunk.id) as { content_hash: string; document_id: string } | undefined;
        if (current === undefined || current.content_hash !== chunk.contentHash) throw new Error('research_embedding_source_changed');
        if (chunk.embeddingInput !== undefined) {
          let inputs = currentInputs.get(current.document_id);
          if (!inputs) {inputs = new Map(this.knowledgeChunks(current.document_id).map(value => [value.id, value])); currentInputs.set(current.document_id, inputs);}
          const latest = inputs.get(chunk.id);
          if (latest?.embeddingInput !== chunk.embeddingInput || latest.inputVersion !== chunk.inputVersion) throw new Error('research_embedding_source_changed');
        }
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
      if(input.cache) {
        if(input.cache.hashes.length!==vectors.length) throw new Error('research_embedding_cache_count_mismatch');
        const cache=this.db.prepare('INSERT OR REPLACE INTO research_embedding_cache VALUES (?,?,?,?,?,?)');
        input.cache.hashes.forEach((hash,index)=>cache.run(config.id,config.revision,input.cache!.version,hash,vectors[index],this.now()));
        this.db.prepare('DELETE FROM research_embedding_cache WHERE config_id=? AND revision<>?').run(config.id,config.revision);
      }
    });
    write();
  }

  cachedEmbedding(configId: string, revision: number, version: string, hash: string): Buffer | null {
    const config=this.requireEmbeddingConfig(configId,revision);
    const row=this.db.prepare('SELECT vector_blob FROM research_embedding_cache WHERE config_id=? AND revision=? AND input_version=? AND input_hash=?')
      .get(configId,revision,version,hash) as {vector_blob:Buffer}|undefined;
    return row ? normalizeEmbeddingBlob(row.vector_blob,config.dimensions) : null;
  }

  cacheEmbeddings(configId: string, revision: number, version: string, hashes: string[], vectors: Buffer[]): void {
    if (hashes.length !== vectors.length) throw new Error('research_embedding_cache_count_mismatch');
    this.db.transaction(() => {
      const config = this.requireEmbeddingConfig(configId, revision);
      const write = this.db.prepare('INSERT OR REPLACE INTO research_embedding_cache VALUES (?,?,?,?,?,?)');
      hashes.forEach((hash, index) => write.run(configId, revision, version, hash,
        normalizeEmbeddingBlob(vectors[index]!, config.dimensions), this.now()));
      this.db.prepare('DELETE FROM research_embedding_cache WHERE config_id=? AND revision<>?').run(configId, revision);
    })();
  }

  searchKnowledge(input: {
    request: ResearchKnowledgeSearchRequest;
    vector: { configId: string; configRevision: number; blob: Buffer } | null;
    degradation?: 'timeout'|'network'|'rate_limit'|'provider_unavailable';
  }): ResearchKnowledgeSearchResult {
    const candidateLimit=input.request.candidateLimit ?? Math.min(200,Math.max(50,input.request.limit*4));
    const documentId = this.queryDocument(input.request);
    const route = routeScientificQuery(input.request.query, documentId);
    const keywordHits = this.keywordSearch(input.request.query, input.request.projectId, candidateLimit, documentId);
    const config = input.vector === null ? null : this.requireEmbeddingConfig(input.vector.configId, input.vector.configRevision);
    const vectorHits = input.vector === null || config === null ? [] : this.vectorSearch(input.request.projectId, candidateLimit,
      { spaceKey: embeddingSpaceKey(config.id, config.revision), dimensions: config.dimensions, blob: input.vector.blob }, documentId);
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
    const ordered = Array.from(merged.values()).map(hit => ({...hit, semantic: this.chunkSemantic(hit.chunkId)})).sort((left, right) => right.rrfScore - left.rrfScore);
    this.preferScientificSections(ordered, route.intent);
    const hits = selectDiverse(ordered, input.request.limit, route.diversify);
    const documents=new Map<string,KnowledgeVersionDocument>();
    const candidates = ordered.map(hit => ({
      ...this.indexedVersion(hit.chunkId, input.request.projectId, documents),
      rerankScore: null,
      keywordRank: hit.keywordRank, vectorRank: hit.vectorRank, score: hit.rrfScore,
      reason: 'sum(1/(60+rank)); equal channel weights' as const,
      outputRank: hits.includes(hit) ? hits.indexOf(hit) + 1 : null
    }));
    const rankingInput = {schemaVersion:3 as const, candidateLimit, route, reranker: {status: 'not_requested' as const, model: null, configHash: null, elapsedMs: 0}, degradation:input.degradation ?? null, projectId: input.request.projectId, limit: input.request.limit,
      embedding: input.vector === null ? null : {configId: input.vector.configId,
        revision: input.vector.configRevision, queryVectorHash: createHash('sha256').update(input.vector.blob).digest('hex')}, candidates};
    return {
      query: input.request.query,
      hits,
      keywordCount: keywordHits.length,
      vectorCount: vectorHits.length,
      embeddingModel: config?.model ?? null,
      generatedAt: this.now(),
      ranking: {ranker: 'rrf-v1-k60', ...rankingInput,
        inputHash: hashText(JSON.stringify({query: input.request.query, ...rankingInput})),
        coverage: {keyword: keywordHits.length ? 'results' : 'no_results',
          vector: input.vector === null ? 'not_searched' : vectorHits.length ? 'results' : 'no_results'}}
    };
  }

  chunkSemantic(chunkId: string): PaperChunk | null {
    const json = this.db.prepare('SELECT metadata_json FROM research_knowledge_chunk_semantics WHERE chunk_id=?').pluck().get(chunkId);
    return typeof json === 'string' ? paperChunkSchema.parse(JSON.parse(json)) : null;
  }

  private preferScientificSections(hits: ResearchKnowledgeSearchHit[], intent: string): void {
    const roles = intent === 'method' || intent === 'comparison' ? ['method'] : intent === 'results'
      ? ['experimental_setup', 'results', 'ablation'] : intent === 'overview' ? ['abstract', 'problem', 'contribution'] : [];
    if (roles.length) hits.sort((a,b) => Number(roles.includes(b.semantic?.semanticRole ?? 'unknown')) - Number(roles.includes(a.semantic?.semanticRole ?? 'unknown')));
  }

  private queryDocument(request: ResearchKnowledgeSearchRequest): string | null {
    const rows = this.db.prepare(`SELECT id,title,metadata_json FROM research_knowledge_documents
      WHERE (? IS NULL OR project_id=? OR project_id IS NULL)`).all(request.projectId, request.projectId) as Array<{id: string; title: string; metadata_json: string}>;
    if (request.documentId) {
      if (!rows.some(row => row.id === request.documentId)) throw new Error('research_knowledge_project_mismatch');
      return request.documentId;
    }
    const query = request.query.toLocaleLowerCase();
    const doi = query.match(/10\.\d{4,9}\/[^\s"<>]+/u)?.[0];
    const matched = rows.filter(row => (row.title.length >= 8 && query.includes(row.title.toLocaleLowerCase())) ||
      (doi !== undefined && row.metadata_json.toLocaleLowerCase().includes(doi)));
    return matched.length === 1 ? matched[0]!.id : null;
  }

  searchCandidates(result: ResearchKnowledgeSearchResult): ResearchKnowledgeSearchHit[] {
    return result.ranking.candidates.map(candidate => {
      const row = this.db.prepare(`SELECT c.id AS chunk_id,c.document_id,d.title,c.content,c.locator,d.source_type,d.source_id
        FROM research_knowledge_chunks c JOIN research_knowledge_documents d ON d.id=c.document_id WHERE c.id=?`)
        .get(candidate.chunkId) as KnowledgeHitRow;
      return {...toKnowledgeHit(row), semantic: this.chunkSemantic(candidate.chunkId), keywordRank: candidate.keywordRank, vectorRank: candidate.vectorRank, rrfScore: candidate.score};
    });
  }

  applyRerank(result: ResearchKnowledgeSearchResult, scores: number[] | null, reranker: RerankerReceipt): ResearchKnowledgeSearchResult {
    this.assertSearchCurrent(result);
    const ordered = this.searchCandidates(result);
    const byId = new Map(ordered.map((hit, index) => [hit.chunkId, scores?.[index] ?? null]));
    if (scores !== null) {
      if (scores.length !== ordered.length || scores.some(score => !Number.isFinite(score))) throw new Error('reranker_scores_invalid');
      ordered.sort((a,b) => byId.get(b.chunkId)! - byId.get(a.chunkId)! || b.rrfScore - a.rrfScore);
    }
    const hits = selectDiverse(ordered, result.ranking.limit, result.ranking.route.diversify);
    const candidates = ordered.map(hit => ({...result.ranking.candidates.find(candidate => candidate.chunkId === hit.chunkId)!,
      rerankScore: byId.get(hit.chunkId)!, outputRank: hits.includes(hit) ? hits.indexOf(hit) + 1 : null}));
    const {inputHash: _hash, ranker, coverage, ...previous} = result.ranking;
    const snapshot = {...previous, reranker, candidates};
    return {...result, hits, ranking: {ranker, coverage, ...snapshot, inputHash: hashText(JSON.stringify({query: result.query, ...snapshot}))}};
  }

  /** A receipt describes the indexed snapshot, never a claim about an unindexed external file. */
  chunkVersion(chunkId: string, projectId: string | null) {
    return this.indexedVersion(chunkId, projectId, new Map());
  }

  assertSearchCurrent(result: ResearchKnowledgeSearchResult): void {
    const {inputHash, ranker: _ranker, coverage: _coverage, ...snapshot} = result.ranking;
    const {projectId, embedding, candidates} = snapshot;
    if (inputHash !== hashText(JSON.stringify({query: result.query, ...snapshot}))) {
      throw new Error('research_knowledge_ranking_changed');
    }
    if (embedding !== null) this.requireEmbeddingConfig(embedding.configId, embedding.revision);
    const documents=new Map<string,KnowledgeVersionDocument>();
    for (const candidate of candidates) {
      if (this.indexedVersion(candidate.chunkId, projectId, documents).indexedVersion !== candidate.indexedVersion) {
        throw new Error('research_knowledge_source_changed');
      }
    }
  }

  private indexedVersion(chunkId: string, projectId: string | null, documents: Map<string,KnowledgeVersionDocument>): {
    chunkId: string; documentId: string; locator: string | null; indexedVersion: string; chunkHash: string;
  } {
    const chunk=this.db.prepare('SELECT document_id,content,content_hash,locator,project_id FROM research_knowledge_chunks WHERE id=?')
      .get(chunkId) as {document_id:string;content:string;content_hash:string;locator:string|null;project_id:string|null}|undefined;
    if (!chunk) throw new Error('research_knowledge_source_missing');
    let document=documents.get(chunk.document_id);
    if (!document) {
      const row=this.db.prepare(`SELECT content AS document_content,content_hash AS document_hash,project_id AS document_project,
        title,source_type,source_id,metadata_json FROM research_knowledge_documents WHERE id=?`).get(chunk.document_id) as KnowledgeVersionDocument & {document_content:string} | undefined;
      if (!row) throw new Error('research_knowledge_source_missing');
      if (hashText(row.document_content)!==row.document_hash) throw new Error('research_knowledge_source_corrupt');
      const {document_content: _content,...fields}=row;
      document=fields; documents.set(chunk.document_id,document);
    }
    if (projectId!==null && ((chunk.project_id!==null && chunk.project_id!==projectId) ||
      (document.document_project!==null && document.document_project!==projectId))) throw new Error('research_knowledge_project_mismatch');
    if (hashText(chunk.content)!==chunk.content_hash) throw new Error('research_knowledge_source_corrupt');
    const {content:_content,...fields}=chunk;
    return {chunkId,documentId:chunk.document_id,locator:chunk.locator,chunkHash:chunk.content_hash,
      indexedVersion:hashText(JSON.stringify({...fields,...document, semantic: this.chunkSemantic(chunkId)}))};
  }

  private keywordSearch(query: string, projectId: string | null, limit: number, documentId: string | null = null): ResearchKnowledgeSearchHit[] {
    if (/\p{Script=Han}/u.test(query)) return this.hanKeywordSearch(query,projectId,limit,documentId);
    const match = query
      .split(/\s+/u)
      .map((term) => term.replace(/"/gu, ''))
      .filter((term) => term.length > 0)
      .map((term) => `"${term}"`)
      .join(' OR ');
    if (match.length === 0) return [];
    const titleMatch = `title : (${match})`;
    const args = [match, projectId, projectId, projectId, projectId, documentId, documentId, titleMatch, projectId, projectId, projectId, projectId, documentId, documentId, limit];
    // Sort candidate identities and ranks; load text only for the selected chunks.
    const rows = this.db
      .prepare(
        `WITH content_hits AS MATERIALIZED (
           SELECT c.id AS chunk_id, c.document_id, c.chunk_index,
                  bm25(research_knowledge_chunks_fts) AS match_rank,
                  0 AS match_source
           FROM research_knowledge_chunks_fts
           JOIN research_knowledge_chunks c ON c.rowid = research_knowledge_chunks_fts.rowid
           JOIN research_knowledge_documents d ON d.id = c.document_id
           WHERE research_knowledge_chunks_fts MATCH ?
             AND NOT EXISTS (SELECT 1 FROM research_knowledge_chunk_structure child WHERE child.parent_chunk_id=c.id)
             AND (? IS NULL OR (c.project_id = ? OR c.project_id IS NULL))
             AND (? IS NULL OR (d.project_id = ? OR d.project_id IS NULL))
             AND (? IS NULL OR d.id = ?)
         ),
         title_hits AS MATERIALIZED (
           SELECT c.id AS chunk_id, c.document_id, c.chunk_index,
                  bm25(research_knowledge_documents_fts, 5.0, 0.0) AS match_rank,
                  1 AS match_source
           FROM research_knowledge_documents_fts
           JOIN research_knowledge_documents d ON d.rowid = research_knowledge_documents_fts.rowid
           JOIN research_knowledge_chunks c ON c.document_id = d.id
           WHERE research_knowledge_documents_fts MATCH ?
             AND NOT EXISTS (SELECT 1 FROM research_knowledge_chunk_structure child WHERE child.parent_chunk_id=c.id)
             AND (? IS NULL OR (c.project_id = ? OR c.project_id IS NULL))
             AND (? IS NULL OR (d.project_id = ? OR d.project_id IS NULL))
             AND (? IS NULL OR d.id = ?)
         ),
         selected AS MATERIALIZED (
           SELECT * FROM (
             SELECT * FROM content_hits
             UNION ALL
             SELECT title_hits.*
             FROM title_hits
             WHERE NOT EXISTS (
               SELECT 1 FROM content_hits WHERE content_hits.chunk_id = title_hits.chunk_id
             )
           )
           ORDER BY match_source ASC, match_rank ASC, document_id ASC, chunk_index ASC
           LIMIT ?
         )
         SELECT selected.chunk_id, c.document_id, d.title, c.content, c.locator, d.source_type, d.source_id
         FROM selected
         JOIN research_knowledge_chunks c ON c.id = selected.chunk_id
         JOIN research_knowledge_documents d ON d.id = c.document_id
         ORDER BY selected.match_source ASC, selected.match_rank ASC, selected.document_id ASC, selected.chunk_index ASC`
      )
      .all(...args) as KnowledgeHitRow[];
    return rows.map((row) => toKnowledgeHit(row));
  }

  private hanKeywordSearch(query: string, projectId: string | null, limit: number, documentId: string | null): ResearchKnowledgeSearchHit[] {
    const match=keywordQueryV1(query);
    if (!match) return [];
    const rows=this.db.prepare(`WITH content_hits AS MATERIALIZED (
      SELECT rowid,bm25(research_knowledge_keywords) AS rank,0 AS source FROM research_knowledge_keywords
      WHERE research_knowledge_keywords MATCH ?), title_hits AS MATERIALIZED (
      SELECT rowid,bm25(research_knowledge_keywords) AS rank,1 AS source FROM research_knowledge_keywords
      WHERE research_knowledge_keywords MATCH ?), hits AS (
      SELECT * FROM content_hits UNION ALL SELECT * FROM title_hits WHERE rowid NOT IN (SELECT rowid FROM content_hits))
      SELECT c.id AS chunk_id,c.document_id,d.title,c.content,c.locator,d.source_type,d.source_id
      FROM hits JOIN research_knowledge_chunks c ON c.rowid=hits.rowid JOIN research_knowledge_documents d ON d.id=c.document_id
      WHERE (? IS NULL OR c.project_id=? OR c.project_id IS NULL) AND (? IS NULL OR d.project_id=? OR d.project_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM research_knowledge_chunk_structure child WHERE child.parent_chunk_id=c.id)
      AND (? IS NULL OR d.id = ?)
      ORDER BY hits.source,hits.rank,c.document_id,c.chunk_index LIMIT ?`)
      .all(`content : (${match})`,`title : (${match})`,projectId,projectId,projectId,projectId,documentId,documentId,limit) as KnowledgeHitRow[];
    return rows.map(toKnowledgeHit);
  }

  private vectorSearch(
    projectId: string | null,
    limit: number,
    vector: { spaceKey: string; dimensions: number; blob: Buffer },
    documentId: string | null = null
  ): ResearchKnowledgeSearchHit[] {
    const blob = normalizeEmbeddingBlob(vector.blob, vector.dimensions);
    const projectJoin = projectId === null && documentId === null ? '' : 'JOIN research_knowledge_chunks scoped ON scoped.id = e.chunk_id';
    const projectClause = (projectId === null ? '' : 'AND (scoped.project_id = ? OR scoped.project_id IS NULL)') +
      (documentId === null ? '' : ' AND scoped.document_id = ?');
    // Rank narrow vector rows first; hydrate document text only for the selected hits.
    // MATERIALIZED keeps SQLite from flattening the joins back into the full scan.
    const args = [blob, vector.spaceKey, vector.dimensions,
      ...(projectId === null ? [] : [projectId]), ...(documentId === null ? [] : [documentId]), limit];
    const rows = this.db
      .prepare(
        `WITH nearest AS MATERIALIZED (
           SELECT e.chunk_id, vec_distance_cosine(e.vector_blob, ?) AS distance
           FROM research_knowledge_embeddings e
           ${projectJoin}
           WHERE e.space_key = ? AND e.dimensions = ? ${projectClause}
           AND NOT EXISTS (SELECT 1 FROM research_knowledge_chunk_structure child WHERE child.parent_chunk_id=e.chunk_id)
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
    semantic: null,
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
