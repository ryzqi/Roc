import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateLocalRetrieval, relevanceMetrics, validateLocalRetrievalCorpus } from '../../scripts/lib/local-retrieval-evaluation.mjs';
const fixture = () => JSON.parse(readFileSync('tests/fixtures/local-retrieval-quality.json', 'utf8'));
test('production FTS and frozen vectors compare identical scoped queries and keep engineering provenance', async () => {
  const report = await evaluateLocalRetrieval(fixture()); assert.equal(report.rows.length, 12); assert.equal(report.groups.length, 12);
  for (const row of report.rows) assert.equal(row.hits.some(id => id.startsWith('foreign:')), false);
  const row = (language, strategy, mode) => report.rows.find(r => r.language === language && r.strategy === strategy && r.mode === mode);
  assert.equal(row('en', 'raw', 'keyword').recall20, 0);
  assert.equal(row('en', 'expanded', 'keyword').recall20, 1);
  assert.equal(row('en', 'raw', 'fusion').recall20, 1);
  assert.equal(row('zh', 'raw', 'keyword').recall20, 1);
  assert.equal(row('zh', 'expanded', 'keyword').recall20, 1);
  assert.match(report.acceptance, /tooling_only.*Blocked, not run/u);
  assert.equal(report.provenance.kind, 'engineering_fixture'); assert.equal(report.split, 'development');
});
test('metrics apply cutoff and graded DCG, and reject unjudged or duplicate retrieval', () => {
  const judgments = [{ chunkId: 'a', grade: 3 }, { chunkId: 'b', grade: 1 }, ...Array.from({ length: 20 }, (_, i) => ({ chunkId: `n-${i}`, grade: 0 }))];
  const actual = relevanceMetrics(['b', 'a'], judgments);
  assert.equal(actual.recall20, 1); assert.ok(actual.ndcg10 < 1 && actual.ndcg10 > 0);
  assert.equal(relevanceMetrics([...judgments.slice(2).map(j => j.chunkId), 'a'], judgments).recall20, 0);
  assert.throws(() => relevanceMetrics(['unknown'], judgments), /unjudged_retrieval_hit/);
  assert.throws(() => relevanceMetrics(['a', 'a'], judgments), /duplicate_retrieval_hits/);
});
test('changed sources, incomplete scope grades, vectors and unmatched strategies fail before loading a database', () => {
  for (const [mutate, error] of [
    [c => { c.documents[0].chunks[0].content += ' tamper'; }, /document_source_changed/],
    [c => { c.queries[0].judgments.pop(); }, /complete_scoped_judgments_required/],
    [c => { c.queries[0].embedding = [0, 0, 0]; }, /embedding_zero_vector/],
    [c => { c.documents[0].chunks[0].embedding = [1]; }, /embedding_dimensions/],
    [c => { c.queries[0].strategies[0].id = 'other'; }, /matched_query_strategies_required/],
    [c => { c.queries[0].judgments[0].reviewer = 'unrecorded'; }, /reviewer_provenance_required/]
  ]) { const corpus = fixture(); mutate(corpus); assert.throws(() => validateLocalRetrievalCorpus(corpus), error); }
});
test('human reviewed provenance requires independent reviewers and never upgrades a generated fixture automatically', () => {
  const c = fixture(); c.provenance.kind = 'human_reviewed';
  assert.throws(() => validateLocalRetrievalCorpus(c), /independent_reviewer_required/);
  c.provenance.reviewers = ['separate-human-reviewer']; for (const q of c.queries) for (const j of q.judgments) j.reviewer = 'separate-human-reviewer';
  assert.equal(validateLocalRetrievalCorpus(c).provenance.kind, 'human_reviewed');
  const old = fixture(); old.contractVersion = 0; assert.throws(() => validateLocalRetrievalCorpus(old));
});
