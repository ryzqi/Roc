import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { publicQasperSearchRequest, scoreQasperRetrieval } from '../adapters/scientific-public/data.mjs';
import { publicScientificSourceLock, verifyPublicScientificSources } from '../adapters/scientific-public/sources.mjs';
import { downloadLockedArtifact } from '../adapters/capability/acquire.mjs';

const document = { id: 'qasper:paper', content: 'first paragraph\n\nsecond paragraph',
  blocks: [{ startOffset: 0, endOffset: 15 }, { startOffset: 17, endOffset: 33 }] };
const task = { visible: { paragraphs: [{ id: 'p0', text: 'first paragraph' }, { id: 'p1', text: 'second paragraph' }] },
  references: [{ evidence: ['first paragraph', 'second paragraph'] }] };
const chunk = (chunkId, startOffset, endOffset, documentId = document.id) => ({ chunkId, startOffset, endOffset, documentId });

test('retrieval gold needs full union coverage; partial spans do not recover a paragraph', () => {
  const state = { chunks: [chunk('a', 0, 5), chunk('b', 5, 15), chunk('c', 17, 33)] };
  assert.equal(scoreQasperRetrieval(task, { hits: [{ chunkId: 'a' }] }, state, document).evidenceRecallAt20, 0);
  assert.equal(scoreQasperRetrieval(task, { hits: [{ chunkId: 'a' }, { chunkId: 'b' }] }, state, document).evidenceRecallAt20, .5);
  const full = scoreQasperRetrieval(task, { hits: state.chunks.map(({ chunkId }) => ({ chunkId })) }, state, document);
  assert.equal(full.evidenceRecallAt20, 1);
  assert.equal(full.reciprocalRank, .5);
});
test('overlapping chunks cannot double count missing parts of gold', () => {
  const state = { chunks: [chunk('a', 0, 8), chunk('b', 0, 8), chunk('c', 9, 15)] };
  const single = { ...task, references: [{ evidence: ['first paragraph'] }] };
  assert.equal(scoreQasperRetrieval(single, { hits: state.chunks.map(({ chunkId }) => ({ chunkId })) }, state, document).evidenceRecallAt20, 0);
});
test('wrong-paper or missing retrieval chunks are rejected', () => {
  assert.throws(() => scoreQasperRetrieval(task, { hits: [{ chunkId: 'x' }] },
    { chunks: [chunk('x', 0, 15, 'another')] }, document), /source_invalid/);
  assert.throws(() => scoreQasperRetrieval(task, { hits: [{ chunkId: 'missing' }] },
    { chunks: [] }, document), /source_invalid/);
});
test('unanswerable has no retrieval-quality score or fabricated successful abstention', () => {
  const score = scoreQasperRetrieval({ ...task, references: [{ evidence: [] }] }, { hits: [] }, { chunks: [] }, document);
  assert.equal(score.unanswerable, true);
  assert.equal(score.evidenceRecallAt20, null);
  assert.equal(score.reciprocalRank, null);
});
test('published query is preserved while the production request is trimmed', () => {
  const questionTask = { visible: { question: 'Is the template-based model realistic?  ' } };
  assert.equal(publicQasperSearchRequest(questionTask, { ...document, projectId: 'project' }).query,
    'Is the template-based model realistic?');
  assert.equal(questionTask.visible.question, 'Is the template-based model realistic?  ');
  assert.throws(() => publicQasperSearchRequest({ visible: { question: '  ' } }, document), /question_empty/);
});
test('chunk relevance includes partial coverage and MRR/nDCG stop at rank ten', () => {
  const state = { chunks: [chunk('gold', 0, 5), ...Array.from({ length: 10 }, (_, i) => chunk(`n${i}`, 17, 33))] };
  const single = { ...task, references: [{ evidence: ['first paragraph'] }] };
  const result = scoreQasperRetrieval(single, { hits: [...state.chunks.slice(1), state.chunks[0]] }, state, document);
  assert.equal(result.evidenceRecallAt20, 0);
  assert.equal(result.chunkRecallAt20, 1);
  assert.equal(result.reciprocalRankAt10, 0);
  assert.equal(result.ndcgAt10, 0);
  const top = scoreQasperRetrieval(single, { hits: [state.chunks[0]] }, state, document);
  assert.equal(top.reciprocalRankAt10, 1);
  assert.equal(top.ndcgAt10, 1);
  assert.throws(() => scoreQasperRetrieval({ ...task, references: [{ evidence: ['unmapped'] }] },
    { hits: [] }, state, document), /evidence_unmapped/);
});
test('public-source checker rejects tampering and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'roc-scientific-public-test-'));
  try {
    const pin = JSON.parse(readFileSync(publicScientificSourceLock)).files[0];
    const path = join(root, pin.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'altered');
    assert.throws(() => verifyPublicScientificSources(root), /source_changed/);
    rmSync(path); symlinkSync('/etc/hosts', path);
    assert.throws(() => verifyPublicScientificSources(root), /path_invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('locked downloader rejects untrusted hosts before any request', async () => {
  await assert.rejects(downloadLockedArtifact({ url: 'https://untrusted.invalid/data', bytes: 1, sha256: '0'.repeat(64) },
    () => { throw new Error('unexpected_network'); }), /url_untrusted/);
});
