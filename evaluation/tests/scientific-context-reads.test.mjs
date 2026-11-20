import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hash, readJson, ROOT, sha256 } from '../lib/common.mjs';
import { readSciegqaIndex } from '../adapters/scientific-public/sciegqa-retrieval.mjs';
import { sciegqaRetrievalConfig, sciegqaRetrievalProject } from '../adapters/scientific-public/sciegqa-retrieval-run.mjs';
import { scientificContextReadPolicy, scientificContextRequests, scientificRetrievalSourceIndex,
  observeScientificRetrievalEvidence, verifyScientificContextRead } from '../lib/scientific-retrieval-observations.mjs';
import { scientificContextArguments } from '../../scripts/capture-scientific-context-reads.mjs';
import { scientificContextRepository } from '../adapters/scientific-context-reads.mjs';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const projectId = sciegqaRetrievalProject;
let modulePromise;
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-scientific-context-')));
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const parsed = { sourceHash: sha256('synthetic PDF'), parserVersion: 'synthetic',
    parserFingerprint: sha256('synthetic-parser'), blocks: [
      { id: 'long-block', kind: 'paragraph', text: 'Orion yield 😀 = 42. '.repeat(600), page: 1 },
      { id: 'neighbor-block', kind: 'paragraph', text: 'Orion adjacent conditions. '.repeat(100), page: 2 },
      { id: 'other-block', kind: 'paragraph', text: 'Orion alternate method. '.repeat(100), page: 3 }
    ].map(b => ({ id: b.id, kind: b.kind, text: b.text, locator: `page ${b.page}`, imagePath: null,
      locations: [{ page: b.page, bbox: [10, 10, 90, 90], coordinateOrigin: 'TOPLEFT' }] })) };
  const resultHash = hash(parsed), source = { id: 'synthetic-paper', title: 'Synthetic paper',
    sourceUri: 'fixture:original-pdf', sourceHash: parsed.sourceHash, resultHash,
    parseId: `evaluation-sciegqa:${resultHash}`, parsed };
  if (!modulePromise) {
    const packages = readJson(join(ROOT, 'package.json'));
    modulePromise = importTypeScriptModule(join(ROOT, 'evaluation/runtime/production-sciegqa-retrieval.ts'), {
      platform: 'node', external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)],
      tempDir: join(ROOT, 'evaluation/.runtime/imports')
    });
  }
  const { openSciegqaRetrieval } = await modulePromise, path = join(root, 'research.sqlite');
  runtime = await openSciegqaRetrieval({ path, sources: [source], projectId,
    config: sciegqaRetrievalConfig, signal: AbortSignal.timeout(120_000) });
  const state = readSciegqaIndex(path, [source], projectId);
  const parseRef = { parseId: source.parseId, parseHash: resultHash, parserFingerprint: parsed.parserFingerprint };
  const observations = [{ projectId, paperId: source.id, sourceHash: source.sourceHash,
    parseRef, status: 'parsed', failureCode: null,
    blocks: parsed.blocks.map(b => ({ id: b.id, blockId: b.id, kind: 'text', text: b.text,
      page: b.locations[0].page, bbox: [.1, .1, .9, .9],
      indexedRanges: state.chunks.filter(c => c.blockId === b.id).map(c => ({
        chunkId: c.chunkId, range: { projectId, paperId: source.id, sourceHash: source.sourceHash,
          ...parseRef, blockId: b.id, page: b.locations[0].page, start: c.startOffset, end: c.endOffset }
      })) })) }];
  const sourceIndex = scientificRetrievalSourceIndex(state, observations);
  const db = new Database(path, { readonly: true });
  const sqlParents = db.prepare(`SELECT c.id,c.document_id AS documentId,c.chunk_index AS 'index'
    FROM research_knowledge_chunks c JOIN research_knowledge_chunk_structure s ON s.chunk_id=c.id
    WHERE s.parent_chunk_id IS NULL ORDER BY c.document_id,c.chunk_index`).all();
  db.close();
  const request = { query: 'Orion yield', projectId, documentId: source.id, limit: 20, embeddingConfigId: null };
  const result = await runtime.search(request, AbortSignal.timeout(10_000));
  const receipt = { questionId: 'synthetic-query', publishedQuery: ' Orion yield ', request, result,
    resultHash: hash(result), failure: null, elapsedMs: 1 };
  const requests = scientificContextRequests(receipt, state);
  const reads = requests.map(request => {
    const result = runtime.context(request);
    return { request, result, resultHash: hash(result), failure: null, elapsedMs: 1,
      startedAt: '2026-11-16T00:00:00.000Z', completedAt: '2026-11-16T00:00:00.001Z' };
  });
  return { root, path, parsed, runtime, state, observations, sourceIndex, sqlParents, receipt, reads, requests };
}

test('actual production ranking and child/parent/neighbor reads retain independent UTF-16 ranges and readonly bytes', async t => {
  const f = await fixture(t), bytes = readFileSync(f.path);
  assert.ok(f.state.chunks.some(c => c.chunkId !== c.parentChunkId));
  const observed = observeScientificRetrievalEvidence(f.receipt, f.sourceIndex, f.sqlParents, f.reads);
  assert.equal(observed.queryId, 'synthetic-query');
  assert.equal(observed.ranking.items.length, f.receipt.result.hits.length);
  assert.equal(f.reads.length, scientificContextReadPolicy.maxReads);
  assert.ok(f.reads.some(r => r.result.context.chunkId !== r.result.context.parentChunkId));
  assert.ok(f.reads.some(r => r.result.neighbors.length > 0));
  assert.ok(f.reads.some(r => r.result.context.content.length < r.result.context.totalChars));
  assert.equal(observed.context.status, 'verified');
  assert.ok(observed.context.items.every(i => i.locators[0].status === 'verified'));
  for (const item of observed.context.items) {
    const r = item.locators[0].range, block = f.parsed.blocks.find(b => b.id === r.blockId);
    assert.equal(r.page, block.locations[0].page);
    assert.ok(r.end - r.start <= 2000);
    assert.equal(r.parseId, f.observations[0].parseRef.parseId);
  }
  assert.deepEqual(observed.unsupportedAnswerEvidence, { status: 'unmeasured', unsupportedPositive: null });
  assert.deepEqual(readFileSync(f.path), bytes);
});

test('host readonly context repository uses the actual production project schema', async t => {
  const f = await fixture(t), bytes = readFileSync(f.path);
  const db = new Database(f.path, { readonly: true, fileMustExist: true });
  try {
    const repository = scientificContextRepository(db, f.runtime.repository.constructor);
    assert.deepEqual(repository.readContext(f.requests[0]), f.reads[0].result);
    assert.throws(() => repository.readContext({ ...f.requests[0], projectId: 'unknown-project' }),
      /research_project_not_found/);
  } finally { db.close(); }
  assert.deepEqual(readFileSync(f.path), bytes);
});

test('self-consistent edited context, swapped neighbors, stale versions and out-of-range offsets reject', async t => {
  const f = await fixture(t), first = f.reads[0], request = f.requests[0];
  for (const alter of [
    r => { r.result.context.content = 'fabricated'; },
    r => { r.result.context.start++; },
    r => { r.result.context.end = r.result.context.totalChars + 1; },
    r => { r.result.context.indexedVersion = hash('old'); },
    r => { r.result.context.locator = 'page 99'; },
    r => { r.result.neighbors = []; },
    r => { r.request.expectedIndexedVersion = hash('old-request'); }
  ]) {
    const r = structuredClone(first); alter(r); r.resultHash = hash(r.result);
    assert.throws(() => verifyScientificContextRead(r, f.sourceIndex, f.sqlParents, request),
      /context_receipt_changed|context_identity_changed|context_source_changed|context_neighbors_changed/);
  }
  assert.throws(() => f.runtime.context({ ...request, expectedIndexedVersion: hash('old') }),
    /research_knowledge_source_changed/);
  assert.throws(() => f.runtime.context({ ...request, projectId: 'outside-project' }));
  const coherent = structuredClone(first), item = coherent.result.context;
  item.end--;
  item.content = item.content.slice(0, -1);
  coherent.resultHash = hash(coherent.result);
  assert.throws(() => verifyScientificContextRead(coherent, f.sourceIndex, f.sqlParents, request),
    /context_window_changed/);
});

test('actual production single-item windows preserve surrogate boundaries at several budgets', async t => {
  const f = await fixture(t), child = f.state.chunks.find(c => c.chunkId !== c.parentChunkId);
  for (const maxChars of [217, 237, 1199, 2000]) {
    const request = { projectId, chunkId: child.chunkId, expectedIndexedVersion: child.indexedVersion,
      neighbors: false, maxChars };
    const result = f.runtime.context(request);
    const read = { request, result, resultHash: hash(result), failure: null, elapsedMs: 1,
      startedAt: '2026-11-16T00:00:00.000Z', completedAt: '2026-11-16T00:00:00.001Z' };
    assert.equal(verifyScientificContextRead(read, f.sourceIndex, f.sqlParents, request).status, 'verified');
    assert.ok(result.context.content.length <= maxChars);
    assert.doesNotMatch(result.context.content[0], /[\uDC00-\uDFFF]/u);
    assert.doesNotMatch(result.context.content.at(-1), /[\uD800-\uDBFF]/u);
  }
});

test('historical missing context, actual zero hits, partial read failure and failed search remain distinct', async t => {
  const f = await fixture(t);
  assert.equal(observeScientificRetrievalEvidence(f.receipt, f.sourceIndex, f.sqlParents).context.status, 'unavailable');
  const reads = structuredClone(f.reads);
  reads[0].failure = { code: 'synthetic-read-failure' }; reads[0].result = null; reads[0].resultHash = null;
  const failed = observeScientificRetrievalEvidence(f.receipt, f.sourceIndex, f.sqlParents, reads);
  assert.equal(failed.ranking.status, 'verified'); assert.equal(failed.context.status, 'failed');
  assert.equal(failed.context.items.length, 0);
  assert.throws(() => observeScientificRetrievalEvidence(f.receipt, f.sourceIndex, f.sqlParents, reads.slice(1)),
    /context_read_count_changed/);
  const noHits = structuredClone(f.receipt);
  noHits.publishedQuery = 'termabsentfromthissource';
  noHits.request.query = noHits.publishedQuery;
  noHits.result = await f.runtime.search(noHits.request, AbortSignal.timeout(10_000));
  assert.deepEqual(noHits.result.hits, []);
  noHits.resultHash = hash(noHits.result);
  const empty = observeScientificRetrievalEvidence(noHits, f.sourceIndex, f.sqlParents, []);
  assert.equal(empty.context.status, 'verified'); assert.deepEqual(empty.context.items, []);
  const noSearch = { ...f.receipt, result: null, resultHash: null, failure: { code: 'synthetic-search-failure' } };
  const failure = observeScientificRetrievalEvidence(noSearch, f.sourceIndex, f.sqlParents, []);
  assert.equal(failure.ranking.status, 'failed'); assert.equal(failure.context.status, 'unavailable');
});

test('wrong source/parse/project, missing indexed ranges and edited saved ranking cannot gain verified observations', async t => {
  const f = await fixture(t);
  for (const alter of [
    s => { s[0].blocks[0].text = 'edited'; },
    s => { s[0].blocks[0].indexedRanges.pop(); },
    s => { s[0].blocks[0].indexedRanges[0].range.parseHash = hash('old'); },
    s => { s[0].blocks[0].indexedRanges[0].range.projectId = 'wrong'; }
  ]) {
    const s = structuredClone(f.observations); alter(s);
    assert.throws(() => scientificRetrievalSourceIndex(f.state, s), /source_index_changed|source_chunk_missing/);
  }
  for (const alter of [
    r => { r.result.hits[0].content = 'edited'; },
    r => { r.result.hits[0].semantic.parseId = 'old'; },
    r => { r.request.projectId = 'wrong'; },
    r => { r.publishedQuery = 'new gold query'; }
  ]) {
    const r = structuredClone(f.receipt); alter(r); r.resultHash = hash(r.result);
    assert.throws(() => observeScientificRetrievalEvidence(r, f.sourceIndex, f.sqlParents), /ranking_source_changed|query_changed/);
  }
});

test('known wrong source page locator remains an invalid occurrence instead of source qualification', async t => {
  const f = await fixture(t), s = structuredClone(f.observations);
  s[0].blocks[0].page = 9;
  for (const e of s[0].blocks[0].indexedRanges) e.range.page = 9;
  const declared = scientificRetrievalSourceIndex(f.state, s);
  const observed = observeScientificRetrievalEvidence(f.receipt, declared, f.sqlParents);
  assert.ok(observed.ranking.items.some(i => i.locators[0].status === 'invalid'));
  // This pure fixture changes declared observations. Only the host checks PDFs.
  assert.equal(observed.context.status, 'unavailable');
});

test('capture CLI rejects overwrite, links, source overlap and malformed arguments before execution', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-context-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'inputs.json'), JSON.stringify({ pdfRoot: join(root, 'pdf'), correspondenceRoot: join(root, 'correspondence') }));
  const output = join(realpathSync(tmpdir()), `context-cli-${hash(root)}.json`);
  t.after(() => rmSync(output, { force: true }));
  const args = ['--run', root, '--output', output];
  assert.equal(scientificContextArguments(args).output, output);
  writeFileSync(output, 'original', { flag: 'wx' });
  assert.throws(() => scientificContextArguments(args), /EEXIST/);
  assert.equal(readFileSync(output, 'utf8'), 'original');
  assert.throws(() => scientificContextArguments(['--run', root, '--output', join(root, 'new.json')]), /overlaps_input/);
  const link = join(root, 'link'); symlinkSync(tmpdir(), link);
  assert.throws(() => scientificContextArguments(['--run', root, '--output', join(link, 'new.json')]), /output_link/);
  const dangling = join(root, 'dangling'); symlinkSync(join(root, 'absent'), dangling);
  assert.throws(() => scientificContextArguments(['--run', root, '--output', join(dangling, 'new.json')]), /output_link/);
  for (const bad of [[], ['--run', root], [...args, '--unknown'], ['--output', output, '--run', root]]) {
    assert.throws(() => scientificContextArguments(bad));
  }
});
