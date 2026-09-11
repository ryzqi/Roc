import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { normalizeEmbeddingBlob, vectorToBlob } from '../../../../src/main/plugins/research/embedding-vectors';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';

describe('embedding cosine representation', () => {
  it('keeps actual sqlite cosine distances finite at very large and small scales', () => {
    const db = new Database(':memory:');
    try {
      sqliteVec.load(db);
      const distance = (left: Buffer, right: Buffer) => (db.prepare('SELECT vec_distance_cosine(?,?) AS value').get(left, right) as { value: number | null }).value;
      for (const scale of [1e100, 1e30, 1e-30, 1e-300]) {
        const vector = vectorToBlob([3 * scale, 4 * scale, 0]);
        expect(distance(vector, vector)).toBeCloseTo(0, 6);
        expect(distance(vector, vectorToBlob([0, 4, 3]))).toBeCloseTo(0.36, 6);
      }
      for (const scale of [1e30, 1e-30]) {
        const raw = Buffer.alloc(12);
        raw.writeFloatLE(scale, 0);
        const normalized = normalizeEmbeddingBlob(raw, 3);
        expect(distance(normalized, vectorToBlob([1, 0, 0]))).toBeCloseTo(0, 6);
      }
    } finally { db.close(); }
  });

  it('normalizes repository inputs so valid directions do not sort by null distances', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      sqliteVec.load(db);
      applyResearchDatabaseSchema(db);
      const repository = new ResearchRepository(db);
      repository.saveEmbeddingConfig({ id: 'test', name: 'Test', baseUrl: 'https://embedding.test', model: 'test', dimensions: 3, apiKey: 'sample-key', enabled: true }, 'sample-reference');
      for (const id of ['large', 'small', 'other']) repository.upsertKnowledgeDocument({ id, projectId: null, sourceType: 'file', sourceId: id, title: id,
        content: id, chunks: [{ content: id, locator: 'line 1' }], embeddingConfigId: null });
      const large = Buffer.alloc(12);
      large.writeFloatLE(1e30, 0);
      const small = Buffer.alloc(12);
      small.writeFloatLE(1e-30, 0);
      repository.storeChunkEmbeddings({ configId: 'test', configRevision: 1, chunks: ['large', 'small', 'other'].flatMap((id) => repository.knowledgeChunks(id)),
        vectors: [large, small, vectorToBlob([0, 1, 0])] });
      const result = repository.searchKnowledge({ request: { query: 'unmatched', projectId: null, limit: 3, embeddingConfigId: 'test' },
        vector: { configId: 'test', configRevision: 1, blob: large } });
      expect(result.hits.slice(0, 2).map((hit) => hit.documentId).sort()).toEqual(['large', 'small']);
      expect(result.hits[2].documentId).toBe('other');
    } finally { db.close(); }
  });

  it('rejects nonfinite, zero and malformed vectors explicitly', () => {
    for (const values of [[], [0, 0], [NaN, 1], [Infinity, 1]]) expect(() => vectorToBlob(values)).toThrow('embedding_vector_invalid');
    expect(() => normalizeEmbeddingBlob(Buffer.alloc(3), 1)).toThrow('embedding_vector_invalid');
  });
});
