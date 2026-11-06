import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';
import { resolve } from 'node:path';
import { importTypeScriptModule } from './bundle-ts.mjs';

const text = z.string().trim().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const vector = z.array(z.number().finite()).min(1);
const provenance = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('engineering_fixture'), producer: text, reviewers: z.array(text).min(1), reviewedAt: z.iso.datetime() }),
  z.strictObject({ kind: z.literal('human_reviewed'), producer: text, reviewers: z.array(text).min(1), reviewedAt: z.iso.datetime() })
]);
export const localRetrievalCorpusSchema = z.strictObject({
  contractVersion: z.literal(1), id: text, split: z.enum(['development', 'test']), provenance,
  embedding: z.strictObject({ model: text, revision: text, producer: text, dimensions: z.number().int().positive() }),
  documents: z.array(z.strictObject({ id: text, projectId: text.nullable(), sourceType: z.enum(['file', 'literature', 'note', 'experiment']),
    sourceId: text, sourceVersion: text, title: text, contentSha256: sha,
    chunks: z.array(z.strictObject({ content: text, locator: text.nullable(), contentSha256: sha, embedding: vector })).min(1) })).min(1),
  queries: z.array(z.strictObject({ id: text, language: z.enum(['zh', 'en', 'mixed']), projectId: text.nullable(),
    embedding: vector, strategies: z.array(z.strictObject({ id: text, query: text })).min(2),
    judgments: z.array(z.strictObject({ chunkId: text, grade: z.number().int().min(0).max(3), reviewer: text })).min(1) })).min(1)
});
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const unique = (values, label) => assert.equal(new Set(values).size, values.length, `duplicate_${label}`);

export function validateLocalRetrievalCorpus(value) {
  const corpus = localRetrievalCorpusSchema.parse(value);
  unique(corpus.documents.map(d => d.id), 'documents'); unique(corpus.queries.map(q => q.id), 'queries');
  unique(corpus.provenance.reviewers, 'reviewers');
  if (corpus.provenance.kind === 'human_reviewed') assert.ok(!corpus.provenance.reviewers.includes(corpus.provenance.producer), 'independent_reviewer_required');
  const checkVector = values => { assert.equal(values.length, corpus.embedding.dimensions, 'embedding_dimensions'); assert.ok(values.some(v => v !== 0), 'embedding_zero_vector'); };
  const chunks = [];
  for (const d of corpus.documents) {
    assert.equal(sha256(d.chunks.map(c => c.content).join('\n')), d.contentSha256, 'document_source_changed');
    d.chunks.forEach((c, index) => { assert.equal(sha256(c.content), c.contentSha256, 'chunk_source_changed'); checkVector(c.embedding); chunks.push({ id: `${d.id}:chunk:${index}`, projectId: d.projectId }); });
  }
  for (const q of corpus.queries) {
    checkVector(q.embedding); unique(q.strategies.map(s => s.id), 'strategies');
    assert.deepEqual(q.strategies.map(s => s.id).sort(), corpus.queries[0].strategies.map(s => s.id).sort(), 'matched_query_strategies_required'); unique(q.judgments.map(j => j.chunkId), 'judgments');
    const scope = chunks.filter(c => q.projectId === null || c.projectId === null || c.projectId === q.projectId).map(c => c.id).sort();
    assert.deepEqual(q.judgments.map(j => j.chunkId).sort(), scope, 'complete_scoped_judgments_required');
    assert.ok(q.judgments.some(j => j.grade > 0), 'relevant_judgment_required');
    assert.ok(q.judgments.every(j => corpus.provenance.reviewers.includes(j.reviewer)), 'reviewer_provenance_required');
  }
  assert.deepEqual([...new Set(corpus.queries.map(q => q.language))].sort(), ['en', 'mixed', 'zh'], 'three_language_groups_required');
  return corpus;
}

export function relevanceMetrics(ids, judgments) {
  const grades = new Map(judgments.map(j => [j.chunkId, j.grade]));
  const relevant = judgments.filter(j => j.grade > 0).length;
  assert.ok(relevant > 0); unique(ids, 'retrieval_hits');
  const dcg = values => values.slice(0, 10).reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
  const rankedGrades = ids.map(id => { assert.ok(grades.has(id), 'unjudged_retrieval_hit'); return grades.get(id); });
  return { recall20: rankedGrades.slice(0, 20).filter(g => g > 0).length / relevant,
    ndcg10: dcg(rankedGrades) / dcg(judgments.map(j => j.grade).sort((a, b) => b - a)), relevant };
}

export async function evaluateLocalRetrieval(value) {
  const corpus = validateLocalRetrievalCorpus(value);
  const [{ ResearchKnowledgeRepository }, { applyResearchDatabaseSchema }, { vectorToBlob }] = await Promise.all([
    importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', { platform: 'node' }),
    importTypeScriptModule('src/main/infrastructure/database-schemas.ts', { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime') }),
    importTypeScriptModule('src/main/plugins/research/embedding-vectors.ts', { platform: 'node' })
  ]);
  const db = new Database(':memory:'); const now = () => corpus.provenance.reviewedAt;
  try {
    load(db); applyResearchDatabaseSchema(db, now);
    const projects = new Set([...corpus.documents.map(d => d.projectId), ...corpus.queries.map(q => q.projectId)].filter(id => id !== null));
    for (const id of projects) db.prepare("INSERT INTO research_projects(id,title,description,status,current_stage,created_at,updated_at) VALUES (?,?,'Isolated quality evaluation','active','reading',?,?)").run(id, id, now(), now());
    const repo = new ResearchKnowledgeRepository(db, id => assert.ok(projects.has(id)), now);
    repo.saveEmbeddingConfig({ id: 'evaluation', name: 'Frozen offline embedding', baseUrl: 'https://fixture.invalid', model: corpus.embedding.model,
      dimensions: corpus.embedding.dimensions, apiKey: 'not-a-provider-credential', enabled: true }, 'unused-offline-secret');
    for (const d of corpus.documents) {
      repo.upsertFromSource({ id: d.id, projectId: d.projectId, sourceType: d.sourceType, sourceId: d.sourceId, title: d.title,
        content: d.chunks.map(c => c.content).join('\n'), chunks: d.chunks.map(c => ({ content: c.content, locator: c.locator })), embeddingPolicy: 'none' },
      { sourceVersion: d.sourceVersion, sourceSha256: d.contentSha256 });
      repo.storeChunkEmbeddings({ configId: 'evaluation', configRevision: 1, chunks: repo.knowledgeChunks(d.id), vectors: d.chunks.map(c => vectorToBlob(c.embedding)) });
    }
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
    const rows = [];
    for (const q of corpus.queries) for (const strategy of q.strategies) for (const mode of ['keyword', 'fusion']) {
      const result = repo.searchKnowledge({ request: { query: strategy.query, projectId: q.projectId, limit: 20 },
        vector: mode === 'keyword' ? null : { configId: 'evaluation', configRevision: 1, blob: vectorToBlob(q.embedding) } });
      const ids = result.hits.map(h => h.chunkId);
      rows.push({ queryId: q.id, language: q.language, projectId: q.projectId, strategy: strategy.id, query: strategy.query, mode,
        ...relevanceMetrics(ids, q.judgments), keywordReturned: result.keywordCount, vectorReturned: result.vectorCount, hits: ids });
    }
    const groups = [];
    for (const language of ['zh', 'en', 'mixed']) for (const strategy of new Set(rows.map(r => r.strategy))) for (const mode of ['keyword', 'fusion']) {
      const selected = rows.filter(r => r.language === language && r.strategy === strategy && r.mode === mode);
      groups.push({ language, strategy, mode, queries: selected.length,
        recall20: selected.reduce((sum, r) => sum + r.recall20, 0) / selected.length,
        ndcg10: selected.reduce((sum, r) => sum + r.ndcg10, 0) / selected.length });
    }
    return { contractVersion: 1, corpusId: corpus.id, corpusSha256: sha256(JSON.stringify(corpus)), split: corpus.split, provenance: corpus.provenance,
      embedding: corpus.embedding, sourceHashes: Object.fromEntries(['src/main/plugins/research/knowledge-repository.ts', 'src/main/plugins/research/embedding-vectors.ts', 'scripts/lib/local-retrieval-evaluation.mjs'].map(path => [path, sha256(readFileSync(path))])),
      sqliteVersion: db.prepare('SELECT sqlite_version()').pluck().get(), rows, groups,
      acceptance: corpus.provenance.kind === 'engineering_fixture' ? 'tooling_only; independent scientific acceptance Blocked, not run' : 'human-reviewed corpus measured; no universal quality or engine-migration claim' };
  } finally { db.close(); }
}
