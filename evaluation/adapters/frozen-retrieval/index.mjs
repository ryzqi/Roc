import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';
import { resolve } from 'node:path';
import { importTypeScriptModule } from '../../../scripts/lib/bundle-ts.mjs';

const text = z.string().trim().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const vector = z.array(z.number().finite()).min(1);
const provenance = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('engineering_fixture'), producer: text, reviewers: z.array(text).min(1), reviewedAt: z.iso.datetime() }),
  z.strictObject({ kind: z.literal('human_reviewed'), producer: text, reviewers: z.array(text).min(1), reviewedAt: z.iso.datetime() })
]);
export const localRetrievalCorpusSchema = z.strictObject({
  contractVersion: z.literal(2), id: text, split: z.enum(['development', 'test']), provenance,
  embedding: z.strictObject({ model: text, revision: text, producer: text, dimensions: z.number().int().positive() }),
  documents: z.array(z.strictObject({ id: text, projectId: text.nullable(), sourceType: z.enum(['file', 'literature', 'note', 'experiment']),
    sourceId: text, sourceVersion: text, current: z.boolean(), title: text, contentSha256: sha,
    chunks: z.array(z.strictObject({ content: text, locator: text.nullable(), section: text.nullable(), contentSha256: sha,
      embeddingInputSha256: sha, embedding: vector })).min(1) })).min(1),
  queries: z.array(z.strictObject({ id: text, language: z.enum(['zh', 'en', 'mixed']), projectId: text.nullable(),
    answerability: z.enum(['answerable', 'no_answer']), tags: z.array(z.enum(['short_term','long_sentence','abbreviation','negation','doi','structure','conflict','stale','multihop'])),
    evidenceChains: z.array(z.array(text).min(1)),
    strategies: z.array(z.strictObject({ id: text, query: text, embedding: vector, embeddingInputSha256: sha,
      candidateLimit: z.number().int().min(50).max(200).default(50), rerank: z.enum(['none','lexical-v1']).default('none') })).min(2),
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
    d.chunks.forEach((c, index) => { assert.equal(sha256(c.content), c.contentSha256, 'chunk_source_changed'); checkVector(c.embedding); chunks.push({ id: `${d.id}:chunk:${index}`, projectId: d.projectId, current: d.current }); });
  }
  for (const q of corpus.queries) {
    for (const s of q.strategies) {checkVector(s.embedding); assert.equal(sha256(s.query), s.embeddingInputSha256, 'query_embedding_input_changed');}
    unique(q.strategies.map(s => s.id), 'strategies');
    assert.deepEqual(q.strategies.map(s => s.id).sort(), corpus.queries[0].strategies.map(s => s.id).sort(), 'matched_query_strategies_required'); unique(q.judgments.map(j => j.chunkId), 'judgments');
    const scope = chunks.filter(c => q.projectId === null || c.projectId === null || c.projectId === q.projectId).map(c => c.id).sort();
    assert.deepEqual(q.judgments.map(j => j.chunkId).sort(), scope, 'complete_scoped_judgments_required');
    assert.equal(q.judgments.some(j => j.grade > 0), q.answerability === 'answerable', 'answerability_judgments_mismatch');
    assert.ok(q.judgments.every(j => j.grade === 0 || chunks.find(c => c.id === j.chunkId).current), 'stale_positive_judgment');
    for (const chain of q.evidenceChains) {
      unique(chain, 'chain_members');
      assert.ok(chain.every(id => q.judgments.some(j => j.chunkId === id && j.grade > 0)), 'chain_requires_positive_scoped_judgments');
    }
    assert.ok(q.judgments.every(j => corpus.provenance.reviewers.includes(j.reviewer)), 'reviewer_provenance_required');
  }
  assert.deepEqual([...new Set(corpus.queries.map(q => q.language))].sort(), ['en', 'mixed', 'zh'], 'three_language_groups_required');
  return corpus;
}

export function relevanceMetrics(ids, judgments, evidenceChains = []) {
  const grades = new Map(judgments.map(j => [j.chunkId, j.grade]));
  const relevant = judgments.filter(j => j.grade > 0).length;
  unique(ids, 'retrieval_hits');
  const dcg = values => values.slice(0, 10).reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
  const rankedGrades = ids.map(id => { assert.ok(grades.has(id), 'unjudged_retrieval_hit'); return grades.get(id); });
  const top20 = new Set(ids.slice(0, 20));
  return { recall20: relevant ? rankedGrades.slice(0, 20).filter(g => g > 0).length / relevant : null,
    ndcg10: relevant ? dcg(rankedGrades) / dcg(judgments.map(j => j.grade).sort((a, b) => b - a)) : null, relevant,
    chainRecall20: evidenceChains.length ? evidenceChains.filter(chain => chain.every(id => top20.has(id))).length / evidenceChains.length : null,
    noAnswerNonempty: relevant ? null : Number(ids.length > 0) };
}

/** Engineering regression of production ranking with frozen vectors; no online ingestion or embedding calls. */
export async function evaluateLocalRetrieval(value) {
  const corpus = validateLocalRetrievalCorpus(value);
  const [{ ResearchKnowledgeRepository }, { applyResearchDatabaseSchema }, { vectorToBlob }] = await Promise.all([
    importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', { platform: 'node', tempDir: resolve('evaluation/.runtime/frozen-retrieval') }),
    importTypeScriptModule('src/main/infrastructure/database-schemas.ts', { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('evaluation/.runtime/frozen-retrieval') }),
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
      if (!d.current) continue;
      repo.upsertFromSource({ id: d.id, projectId: d.projectId, sourceType: d.sourceType, sourceId: d.sourceId, title: d.title,
        content: d.chunks.map(c => c.content).join('\n'), chunks: d.chunks.map(c => ({ content: c.content, locator: c.locator, section: c.section })), embeddingPolicy: 'none' },
      { sourceVersion: d.sourceVersion, sourceSha256: d.contentSha256 });
      const chunks = repo.knowledgeChunks(d.id);
      assert.deepEqual(chunks.map(c => c.id), d.chunks.map((_,i) => `${d.id}:chunk:${i}`), 'frozen_chunk_layout_changed');
      chunks.forEach((c,i) => assert.equal(sha256(c.embeddingInput), d.chunks[i].embeddingInputSha256, 'document_embedding_input_changed'));
      repo.storeChunkEmbeddings({ configId: 'evaluation', configRevision: 1, chunks, vectors: d.chunks.map(c => vectorToBlob(c.embedding)) });
    }
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
    const rows = [];
    for (const q of corpus.queries) for (const strategy of q.strategies) for (const mode of ['keyword', 'fusion']) {
      const result = repo.searchKnowledge({ request: { query: strategy.query, projectId: q.projectId, limit: 20,
        candidateLimit: strategy.candidateLimit, rerank: strategy.rerank },
        vector: mode === 'keyword' ? null : { configId: 'evaluation', configRevision: 1, blob: vectorToBlob(strategy.embedding) } });
      repo.assertSearchCurrent(result);
      const ids = result.hits.map(h => h.chunkId);
      rows.push({ queryId: q.id, language: q.language, projectId: q.projectId, strategy: strategy.id, query: strategy.query, mode,
        answerability: q.answerability, tags: q.tags, queryEmbeddingInputSha256: strategy.embeddingInputSha256,
        ...relevanceMetrics(ids, q.judgments, q.evidenceChains), keywordReturned: result.keywordCount, vectorReturned: result.vectorCount,
        ranking: result.ranking, hits: ids });
    }
    const groups = [];
    for (const language of ['zh', 'en', 'mixed']) for (const strategy of new Set(rows.map(r => r.strategy))) for (const mode of ['keyword', 'fusion']) {
      const selected = rows.filter(r => r.language === language && r.strategy === strategy && r.mode === mode);
      const mean = key => {const values = selected.map(r => r[key]).filter(v => v !== null);return values.length ? values.reduce((a,b) => a+b,0)/values.length : null;};
      groups.push({ language, strategy, mode, queries: selected.length,
        answerableQueries: selected.filter(r=>r.relevant>0).length,
        noAnswerQueries: selected.filter(r=>r.relevant===0).length,
        recall20: mean('recall20'), ndcg10: mean('ndcg10'), chainRecall20: mean('chainRecall20'), noAnswerNonemptyRate: mean('noAnswerNonempty') });
    }
    return { contractVersion: 2, evaluationMode: 'frozen-embedding', evaluationPurpose: 'engineering-regression',
      corpusId: corpus.id, corpusSha256: sha256(JSON.stringify(corpus)), split: corpus.split, provenance: corpus.provenance,
      embedding: corpus.embedding, sourceHashes: Object.fromEntries(['src/main/plugins/research/knowledge-repository.ts', 'src/main/plugins/research/embedding-vectors.ts', 'evaluation/adapters/frozen-retrieval/index.mjs'].map(path => [path, sha256(readFileSync(path))])),
      sqliteVersion: db.prepare('SELECT sqlite_version()').pluck().get(), rows, groups,
      metricLimits: 'noAnswerNonemptyRate measures retrieval output, not answer refusal; chainRecall20 measures annotated chunk coverage, not reasoning correctness; frozen vectors require external producer provenance; frozen-embedding engineering regression does not measure online ingestion or embedding/index-build quality',
      acceptance: corpus.provenance.kind === 'engineering_fixture' ? 'tooling_only; independent scientific acceptance Blocked, not run' : 'human-reviewed corpus measured; no universal quality or engine-migration claim' };
  } finally { db.close(); }
}
