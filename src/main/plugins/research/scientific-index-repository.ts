import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {z} from 'zod';
import {paperIrArtifactSchema, type PaperIRArtifact, type PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {paperIRArtifact, assertPaperIRArtifact} from './paper-ir-repository';
import {buildScientificChunks, scientificChunkVersion, scientificChunkDefaults,
  type ScientificChunk, type ScientificChunkPolicy} from './scientific-chunks';
import {normalizeEmbeddingBlob, vectorToBlob} from './embedding-vectors';
import {researchContentHash} from './research-files';

export const scientificEmbeddingIdentitySchema = z.object({
  configId: z.string().min(1), revision: z.number().int().positive(),
  model: z.string().min(1), dimensions: z.number().int().positive()
}).strict();
export type ScientificEmbeddingIdentity = z.infer<typeof scientificEmbeddingIdentitySchema>;
const snapshotSchema = z.object({
  projectId: z.string().min(1).nullable(),
  source: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('library')}).strict(),
    z.object({kind: z.literal('project'), fileId: z.string().min(1), artifactId: z.string().min(1)}).strict()
  ]),
  paperIR: paperIrArtifactSchema,
  embedding: scientificEmbeddingIdentitySchema.nullable(),
  chunkVersion: z.literal(scientificChunkVersion),
  policy: z.object({paragraphTokens: z.number().int(), tableTokens: z.number().int(), algorithmTokens: z.number().int()}).strict()
}).strict();
export type ScientificIndexSnapshot = z.infer<typeof snapshotSchema>;
export type ScientificIndexCurrent = {paperIR: PaperIRArtifact; embedding: ScientificEmbeddingIdentity | null};
export type ScientificGenerationStatus = 'building' | 'active' | 'retired' | 'failed' | 'cancelled';
export type ScientificGeneration = {
  id: string; snapshot: ScientificIndexSnapshot; status: ScientificGenerationStatus; error: string | null;
  chunkCount: number; retrievableCount: number; chunksHash: string; relationsHash: string;
  createdAt: string; publishedAt: string | null;
};
type GenerationRow = {
  id: string; project_id: string | null; document_id: string; scope_key: string; source_hash: string;
  parse_id: string; parse_hash: string; paper_ir_version: string; chunk_version: string;
  embedding_config_id: string | null; embedding_config_revision: number | null; embedding_model: string | null; dimensions: number | null;
  snapshot_json: string; snapshot_hash: string; chunk_count: number; retrievable_count: number;
  chunks_hash: string; relations_hash: string; status: ScientificGenerationStatus; error: string | null;
  created_at: string; published_at: string | null;
};
type ChunkRow = {
  generation_id: string; id: string; project_id: string | null; document_id: string; paper_id: string;
  object_id: string; parent_id: string | null; chunk_type: string; section_path: string; semantic_roles: string;
  content: string; embedding_text: string; locator_json: string; content_hash: string; input_version: string;
  embedding_text_hash: string; chunk_json: string; chunk_hash: string; retrieval: number; ordinal: number;
};
type RelationRow = {chunk_id: string; relation_id: string; relation_json: string};
type EmbeddingRow = {
  chunk_id: string; config_id: string; config_revision: number; model: string; input_version: string;
  input_hash: string; dimensions: number; embedding: Buffer; embedding_hash: string;
};
function hash(value: unknown): string {return researchContentHash(JSON.stringify(value));}
function scopeKey(projectId: string | null, documentId: string): string {return hash([projectId, documentId]);}
function relationHash(rows: RelationRow[]): string {
  return hash(rows.toSorted((a, b) => a.chunk_id.localeCompare(b.chunk_id) || a.relation_id.localeCompare(b.relation_id)));
}
function chunkValues(generationId: string, projectId: string | null, chunk: ScientificChunk, ordinal: number): ChunkRow {
  const json = JSON.stringify(chunk);
  return {generation_id: generationId, id: chunk.id, project_id: projectId, document_id: chunk.documentId,
    paper_id: chunk.paperId, object_id: chunk.objectId, parent_id: chunk.parentId, chunk_type: chunk.chunkType,
    section_path: JSON.stringify(chunk.sectionPath), semantic_roles: JSON.stringify(chunk.semantic.roles),
    content: chunk.content, embedding_text: chunk.embeddingText, locator_json: JSON.stringify(chunk.sourceLocator),
    content_hash: chunk.contentHash, input_version: chunk.inputVersion, embedding_text_hash: chunk.embeddingTextHash,
    chunk_json: json, chunk_hash: researchContentHash(json), retrieval: Number(chunk.retrieval), ordinal};
}

/** Immutable generations outlive the generic live knowledge index. No parse/evidence artifacts are deleted here. */
export class ScientificIndexRepository {
  constructor(private readonly db: Database, private readonly now: () => string = () => new Date().toISOString()) {}

  begin(input: {ir: PaperIRV2; projectId: string | null; source: ScientificIndexSnapshot['source'];
    embedding: ScientificEmbeddingIdentity | null; paperIR?: PaperIRArtifact; policy?: Partial<ScientificChunkPolicy>}): ScientificGeneration {
    const receipt = input.paperIR ?? paperIRArtifact(input.ir);
    assertPaperIRArtifact(receipt, input.ir);
    const snapshot = snapshotSchema.parse({projectId: input.projectId, source: input.source, paperIR: receipt,
      embedding: input.embedding, chunkVersion: scientificChunkVersion, policy: {...scientificChunkDefaults, ...input.policy}});
    if ((snapshot.projectId === null) !== (snapshot.source.kind === 'library') ||
      (snapshot.source.kind === 'project' && snapshot.source.artifactId !== receipt.identity.parseId)) {
      throw new Error('research_scientific_scope_invalid');
    }
    const chunks = buildScientificChunks(input.ir, snapshot.policy), identity = receipt.identity;
    const id = `scientific-generation:${randomUUID()}`, key = scopeKey(snapshot.projectId, identity.documentId);
    const relationMap = new Map(input.ir.relations.map(r => [r.id, r]));
    const relations = chunks.flatMap(c => c.relationIds.map(relationId => ({
      chunk_id: c.id, relation_id: relationId, relation_json: JSON.stringify(relationMap.get(relationId)!)})));
    const json = JSON.stringify(snapshot), timestamp = this.now();
    this.db.transaction(() => {
      // A newer attempt supersedes only unfinished work, never the usable active generation.
      this.db.prepare(`UPDATE research_scientific_index_generations SET status='cancelled',
        error='research_scientific_superseded' WHERE scope_key=? AND status='building'`).run(key);
      this.db.prepare(`INSERT INTO research_scientific_index_generations
        (id,project_id,document_id,scope_key,source_hash,parse_id,parse_hash,paper_ir_version,chunk_version,
         embedding_config_id,embedding_config_revision,embedding_model,dimensions,snapshot_json,snapshot_hash,
         chunk_count,retrievable_count,chunks_hash,relations_hash,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'building',?)`)
        .run(id, snapshot.projectId, identity.documentId, key, identity.sourceHash, identity.parseId, identity.parseHash,
          receipt.version, scientificChunkVersion, snapshot.embedding?.configId ?? null, snapshot.embedding?.revision ?? null,
          snapshot.embedding?.model ?? null, snapshot.embedding?.dimensions ?? null, json, researchContentHash(json),
          chunks.length, chunks.filter(c => c.retrieval).length, hash(chunks), relationHash(relations), timestamp);
      const insert = this.db.prepare(`INSERT INTO research_scientific_chunks
        (generation_id,id,project_id,document_id,paper_id,object_id,parent_id,chunk_type,section_path,semantic_roles,
         content,embedding_text,locator_json,content_hash,input_version,embedding_text_hash,chunk_json,chunk_hash,retrieval,ordinal)
        VALUES (@generation_id,@id,@project_id,@document_id,@paper_id,@object_id,@parent_id,@chunk_type,@section_path,@semantic_roles,
         @content,@embedding_text,@locator_json,@content_hash,@input_version,@embedding_text_hash,@chunk_json,@chunk_hash,@retrieval,@ordinal)`);
      chunks.forEach((chunk, ordinal) => insert.run(chunkValues(id, snapshot.projectId, chunk, ordinal)));
      const insertRelation = this.db.prepare('INSERT INTO research_scientific_chunk_relations VALUES (?,?,?,?)');
      relations.forEach(r => insertRelation.run(id, r.chunk_id, r.relation_id, r.relation_json));
    }).immediate();
    return this.get(id);
  }

  get(id: string): ScientificGeneration {
    const row = this.row(id), snapshot = snapshotSchema.parse(JSON.parse(row.snapshot_json)), identity = snapshot.paperIR.identity;
    if (researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
      row.project_id !== snapshot.projectId || row.document_id !== identity.documentId ||
      row.scope_key !== scopeKey(snapshot.projectId, identity.documentId) || row.source_hash !== identity.sourceHash ||
      row.parse_id !== identity.parseId || row.parse_hash !== identity.parseHash ||
      row.paper_ir_version !== snapshot.paperIR.version || row.chunk_version !== snapshot.chunkVersion ||
      row.embedding_config_id !== (snapshot.embedding?.configId ?? null) ||
      row.embedding_config_revision !== (snapshot.embedding?.revision ?? null) ||
      row.embedding_model !== (snapshot.embedding?.model ?? null) || row.dimensions !== (snapshot.embedding?.dimensions ?? null)) {
      throw new Error('research_scientific_snapshot_changed');
    }
    return {id: row.id, snapshot, status: row.status, error: row.error, chunkCount: row.chunk_count,
      retrievableCount: row.retrievable_count, chunksHash: row.chunks_hash, relationsHash: row.relations_hash,
      createdAt: row.created_at, publishedAt: row.published_at};
  }

  active(projectId: string | null, documentId: string): ScientificGeneration | null {
    const row = this.db.prepare("SELECT id FROM research_scientific_index_generations WHERE scope_key=? AND status='active'")
      .get(scopeKey(projectId, documentId)) as {id: string} | undefined;
    return row ? this.get(row.id) : null;
  }

  history(projectId: string | null, documentId: string): ScientificGeneration[] {
    const rows = this.db.prepare(`SELECT id FROM research_scientific_index_generations WHERE scope_key=?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'building' THEN 1 ELSE 2 END,
        created_at DESC,rowid DESC LIMIT 100`).all(scopeKey(projectId, documentId)) as Array<{id: string}>;
    return rows.map(row => this.get(row.id));
  }

  /** Retained compatible indices switch without parsing, embedding, or generic consumer publication. */
  activateRetired(id: string, expectedActiveId: string, current: () => ScientificIndexCurrent): ScientificGeneration {
    this.db.transaction(() => {
      const target = this.get(id), {projectId, paperIR} = target.snapshot;
      const active = this.active(projectId, paperIR.identity.documentId);
      if (active?.id !== expectedActiveId) throw new Error('research_scientific_active_changed');
      if (target.status !== 'retired' || target.publishedAt === null) {
        throw new Error('research_scientific_generation_not_retired');
      }
      this.verify(id);
      const state = current();
      // Owner publications are immutable here: switching to a different parse requires coordinated publication.
      if (JSON.stringify(active.snapshot.source) !== JSON.stringify(target.snapshot.source) ||
        JSON.stringify(active.snapshot.paperIR) !== JSON.stringify(paperIR) ||
        JSON.stringify(paperIrArtifactSchema.parse(state.paperIR)) !== JSON.stringify(paperIR)) {
        throw new Error('research_scientific_source_changed');
      }
      const embedding = state.embedding === null ? null : scientificEmbeddingIdentitySchema.parse(state.embedding);
      if (JSON.stringify(embedding) !== JSON.stringify(target.snapshot.embedding)) {
        throw new Error('research_scientific_embedding_changed');
      }
      const key = scopeKey(projectId, paperIR.identity.documentId);
      this.db.prepare(`UPDATE research_scientific_index_generations SET status='cancelled',
        error='research_scientific_rollback_superseded' WHERE scope_key=? AND status='building'`).run(key);
      this.db.prepare("UPDATE research_scientific_index_generations SET status='retired' WHERE id=?").run(active.id);
      this.db.prepare("UPDATE research_scientific_index_generations SET status='active' WHERE id=?").run(id);
    }).immediate();
    return this.get(id);
  }

  /** Filter shared-library membership before loading a manifest, including manifests outside this project. */
  activeInScope(projectId: string | null, authorizeLibrary: (documentId: string) => boolean): ScientificGeneration[] {
    const result: ScientificGeneration[] = [];
    const rows = this.db.prepare(`SELECT id,project_id,document_id FROM research_scientific_index_generations
      WHERE status='active' AND (project_id IS NULL OR project_id=?) ORDER BY document_id,id`)
      .iterate(projectId) as Iterable<{id: string; project_id: string | null; document_id: string}>;
    for (const row of rows) {
      if (row.project_id === null && !authorizeLibrary(row.document_id)) continue;
      if (result.length >= 1000) throw new Error('research_scientific_catalog_budget_exceeded');
      result.push(this.get(row.id));
    }
    return result;
  }

  /** Caller captures and verifies the generation set once; SQL never expands an empty set to the whole index. */
  textHits(generationIds: readonly string[], match: string, limit: number,
    types: readonly string[] = ['paragraph', 'algorithm', 'caption']): Array<{generationId: string; chunkId: string; score: number}> {
    if (!generationIds.length || !match) return [];
    return this.db.prepare(`SELECT f.generation_id AS generationId,f.chunk_id AS chunkId,
      bm25(research_scientific_fts) AS score FROM research_scientific_fts f
      WHERE research_scientific_fts MATCH ? AND f.generation_id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM research_scientific_chunks c WHERE c.generation_id=f.generation_id AND c.id=f.chunk_id
        AND c.chunk_type IN (SELECT value FROM json_each(?)))
      ORDER BY score,f.generation_id,f.chunk_id LIMIT ?`).all(match, JSON.stringify(generationIds), JSON.stringify(types), limit) as
      Array<{generationId: string; chunkId: string; score: number}>;
  }

  denseHits(generationIds: readonly string[], vector: Buffer, limit: number,
    types: readonly string[] = ['paragraph', 'algorithm', 'caption']): Array<{generationId: string; chunkId: string; score: number}> {
    if (!generationIds.length) return [];
    return this.db.prepare(`SELECT e.generation_id AS generationId,e.chunk_id AS chunkId,
      vec_distance_cosine(e.embedding,?) AS score FROM research_scientific_embeddings e
      WHERE e.generation_id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM research_scientific_chunks c WHERE c.generation_id=e.generation_id AND c.id=e.chunk_id
        AND c.chunk_type IN (SELECT value FROM json_each(?)))
      ORDER BY score,e.generation_id,e.chunk_id LIMIT ?`).all(vector, JSON.stringify(generationIds), JSON.stringify(types), limit) as
      Array<{generationId: string; chunkId: string; score: number}>;
  }

  /** unicode61 has no Han word segmentation; this bounded fallback retains exact source text. */
  lexicalHits(generationIds: readonly string[], terms: readonly string[], limit: number): Array<{generationId: string; chunkId: string; score: number}> {
    if (!generationIds.length || !terms.length) return [];
    return this.db.prepare(`SELECT c.generation_id AS generationId,c.id AS chunkId,
      -COUNT(*) AS score FROM research_scientific_chunks c JOIN json_each(?) term
      ON instr(lower(c.embedding_text),lower(term.value))>0
      WHERE c.generation_id IN (SELECT value FROM json_each(?)) AND c.retrieval=1
      AND c.chunk_type IN ('paragraph','algorithm','caption')
      GROUP BY c.generation_id,c.id ORDER BY score,generationId,chunkId LIMIT ?`)
      .all(JSON.stringify(terms), JSON.stringify(generationIds), limit) as Array<{generationId: string; chunkId: string; score: number}>;
  }

  chunks(id: string, projectId: string | null): ScientificChunk[] {
    const generation = this.get(id);
    if (generation.snapshot.projectId !== projectId) throw new Error('research_scientific_scope_invalid');
    const rows = this.chunkRows(id);
    const chunks = rows.map((row, ordinal) => {
      const chunk = JSON.parse(row.chunk_json) as ScientificChunk;
      const expected = chunkValues(id, projectId, chunk, ordinal);
      if (Object.entries(expected).some(([key, value]) => row[key as keyof ChunkRow] !== value) ||
        chunk.documentId !== generation.snapshot.paperIR.identity.documentId ||
        chunk.parseId !== generation.snapshot.paperIR.identity.parseId ||
        chunk.sourceLocator.parseHash !== generation.snapshot.paperIR.identity.parseHash ||
        chunk.contentHash !== researchContentHash(chunk.content) ||
        chunk.embeddingTextHash !== researchContentHash(chunk.embeddingText)) {
        throw new Error('research_scientific_chunks_changed');
      }
      return chunk;
    });
    if (chunks.length !== generation.chunkCount || chunks.filter(c => c.retrieval).length !== generation.retrievableCount ||
      hash(chunks) !== generation.chunksHash) throw new Error('research_scientific_chunks_changed');
    return chunks;
  }

  writeEmbeddings(id: string, identity: ScientificEmbeddingIdentity,
    values: Array<{chunkId: string; vector: readonly number[]}>): void {
    this.db.transaction(() => {
      const generation = this.requireBuilding(id);
      if (JSON.stringify(scientificEmbeddingIdentitySchema.parse(identity)) !== JSON.stringify(generation.snapshot.embedding)) {
        throw new Error('research_scientific_embedding_changed');
      }
      const chunks = new Map(this.chunks(id, generation.snapshot.projectId).filter(c => c.retrieval).map(c => [c.id, c]));
      const insert = this.db.prepare(`INSERT INTO research_scientific_embeddings
        (generation_id,chunk_id,config_id,config_revision,model,input_version,input_hash,dimensions,embedding,embedding_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const seen = new Set<string>();
      for (const value of values) {
        const chunk = chunks.get(value.chunkId);
        if (!chunk || seen.has(value.chunkId)) throw new Error('research_scientific_embedding_chunk_invalid');
        seen.add(value.chunkId);
        if (value.vector.length !== identity.dimensions) throw new Error('research_scientific_embedding_dimensions_invalid');
        const blob = vectorToBlob(value.vector);
        insert.run(id, chunk.id, identity.configId, identity.revision, identity.model, chunk.inputVersion,
          chunk.embeddingTextHash, identity.dimensions, blob, researchContentHash(blob));
      }
    }).immediate();
  }

  /** Called inside the publication transaction; the owning catalog supplies current source/config, never the candidate itself. */
  publish(id: string, current: () => ScientificIndexCurrent, publishConsumer?: () => unknown): ScientificGeneration {
    this.db.transaction(() => {
      const generation = this.requireBuilding(id), state = current();
      if (JSON.stringify(paperIrArtifactSchema.parse(state.paperIR)) !== JSON.stringify(generation.snapshot.paperIR)) {
        throw new Error('research_scientific_source_changed');
      }
      const embedding = state.embedding === null ? null : scientificEmbeddingIdentitySchema.parse(state.embedding);
      if (JSON.stringify(embedding) !== JSON.stringify(generation.snapshot.embedding)) {
        throw new Error('research_scientific_embedding_changed');
      }
      this.verify(id);
      const key = scopeKey(generation.snapshot.projectId, generation.snapshot.paperIR.identity.documentId);
      this.db.prepare("UPDATE research_scientific_index_generations SET status='retired' WHERE scope_key=? AND status='active'").run(key);
      this.db.prepare("UPDATE research_scientific_index_generations SET status='active',published_at=? WHERE id=? AND status='building'")
        .run(this.now(), id);
      // Any generic consumer publication must commit with this switch, or both roll back.
      const consumer = publishConsumer?.();
      if (consumer !== null && typeof consumer === 'object' && 'then' in consumer) {
        throw new Error('research_scientific_publication_must_be_synchronous');
      }
    }).immediate();
    return this.get(id);
  }

  verify(id: string): void {
    const generation = this.get(id), chunks = this.chunks(id, generation.snapshot.projectId);
    const fts = this.db.prepare('SELECT chunk_id,content FROM research_scientific_fts WHERE generation_id=?').all(id) as
      Array<{chunk_id: string; content: string}>;
    const retrieval = new Map(chunks.filter(c => c.retrieval).map(c => [c.id, c]));
    if (fts.length !== retrieval.size || new Set(fts.map(row => row.chunk_id)).size !== retrieval.size ||
      fts.some(row => row.content !== retrieval.get(row.chunk_id)?.embeddingText)) throw new Error('research_scientific_fts_invalid');
    const relations = this.db.prepare('SELECT chunk_id,relation_id,relation_json FROM research_scientific_chunk_relations WHERE generation_id=?')
      .all(id) as RelationRow[];
    if (relationHash(relations) !== generation.relationsHash) throw new Error('research_scientific_relations_changed');
    const vectors = this.embeddingRows(id), identity = generation.snapshot.embedding;
    if (vectors.length !== (identity === null ? 0 : retrieval.size)) throw new Error('research_scientific_embeddings_incomplete');
    for (const row of vectors) {
      const chunk = retrieval.get(row.chunk_id);
      if (!identity || !chunk || row.config_id !== identity.configId || row.config_revision !== identity.revision ||
        row.model !== identity.model || row.dimensions !== identity.dimensions || row.input_version !== chunk.inputVersion ||
        row.input_hash !== chunk.embeddingTextHash || researchContentHash(row.embedding) !== row.embedding_hash) {
        throw new Error('research_scientific_embedding_changed');
      }
      normalizeEmbeddingBlob(row.embedding, identity.dimensions);
    }
  }

  embeddings(id: string, projectId: string | null): Array<{chunkId: string; vector: number[]}> {
    if (this.get(id).snapshot.projectId !== projectId) throw new Error('research_scientific_scope_invalid');
    this.verify(id);
    return this.embeddingRows(id).map(row => ({chunkId: row.chunk_id,
      vector: Array.from({length: row.dimensions}, (_, index) => row.embedding.readFloatLE(index * 4))}));
  }

  fail(id: string, error: string, cancelled = false): void {
    this.db.prepare("UPDATE research_scientific_index_generations SET status=?,error=? WHERE id=? AND status='building'")
      .run(cancelled ? 'cancelled' : 'failed', error, id);
  }

  /** A removed/archived source leaves readable history, but cannot remain an active retrieval source. */
  retireSource(projectId: string | null, documentId: string): void {
    this.db.transaction(() => {
      const key = scopeKey(projectId, documentId);
      this.db.prepare("UPDATE research_scientific_index_generations SET status='retired' WHERE scope_key=? AND status='active'").run(key);
      this.db.prepare("UPDATE research_scientific_index_generations SET status='cancelled',error='research_scientific_source_removed' WHERE scope_key=? AND status='building'").run(key);
    })();
  }

  /** Return original owners to the scheduler for a fresh attempt; partial data and active history stay intact. */
  recover(owner?: 'project' | 'library'): ScientificGeneration[] {
    return this.db.transaction(() => {
      const scope = owner === undefined ? '' : owner === 'project' ? ' AND project_id IS NOT NULL' : ' AND project_id IS NULL';
      const rows = this.db.prepare(`SELECT id FROM research_scientific_index_generations WHERE status='building'${scope}`).all() as Array<{id: string}>;
      const interrupted = rows.map(row => this.get(row.id));
      this.db.prepare(`UPDATE research_scientific_index_generations SET status='cancelled',
        error='research_scientific_interrupted' WHERE status='building'${scope}`).run();
      return interrupted;
    }).immediate();
  }

  /** Conservatively pin every historical project generation; future GC must account for evidence/revision readers. */
  referencedArtifacts(): Set<string> {
    const rows = this.db.prepare('SELECT id FROM research_scientific_index_generations').all() as Array<{id: string}>;
    return new Set(rows.flatMap(row => {
      const source = this.get(row.id).snapshot.source;
      return source.kind === 'project' ? [source.artifactId] : [];
    }));
  }

  private row(id: string): GenerationRow {
    const row = this.db.prepare('SELECT * FROM research_scientific_index_generations WHERE id=?').get(id) as GenerationRow | undefined;
    if (!row) throw new Error('research_scientific_generation_not_found');
    return row;
  }
  private requireBuilding(id: string): ScientificGeneration {
    const generation = this.get(id);
    if (generation.status !== 'building') throw new Error('research_scientific_generation_not_building');
    return generation;
  }
  private chunkRows(id: string): ChunkRow[] {
    return this.db.prepare('SELECT * FROM research_scientific_chunks WHERE generation_id=? ORDER BY ordinal').all(id) as ChunkRow[];
  }
  private embeddingRows(id: string): EmbeddingRow[] {
    return this.db.prepare('SELECT * FROM research_scientific_embeddings WHERE generation_id=? ORDER BY chunk_id').all(id) as EmbeddingRow[];
  }
}
