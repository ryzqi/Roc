import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import Database from 'better-sqlite3';
import {directory, hash, readJson, ROOT, sha256} from '../lib/common.mjs';
import {verifyRagSearch} from '../adapters/rag/evidence.mjs';
import {mapSciegqaRegions, readSciegqaIndex, sciegqaRegionIou,
  scoreSciegqaRegionRetrieval} from '../adapters/scientific-public/sciegqa-retrieval.mjs';
import {evaluateSciegqaQuery, sciegqaFailure, sciegqaRetrievalConfig, sciegqaRetrievalProject,
  sciegqaSearchRequest, summarizeSciegqaRetrieval, verifySciegqaExecutionArtifacts,
  verifySciegqaRetrievalHeader} from '../adapters/scientific-public/sciegqa-retrieval-run.mjs';
import {sciegqaRegionRetrievalContract} from '../adapters/scientific-public/sciegqa-retrieval.mjs';

function fixture() {
  const text = 'Orion yield was 42 units. 😀\n\n'.repeat(150);
  const parsed = {sourceHash: sha256('original PDF'), parserVersion: 'test-parser',
    parserFingerprint: sha256('test-fingerprint'), blocks: [
      {id: 'original-block', kind: 'paragraph', text, locator: 'PDF page 2',
        locations: [{page: 2, coordinateOrigin: 'TOPLEFT', bbox: [10, 20, 50, 60]}]},
      {id: 'original-figure', kind: 'figure', text: 'Orion architecture', locator: 'PDF page 2 figure',
        locations: [{page: 2, coordinateOrigin: 'TOPLEFT', bbox: [10, 20, 50, 60]}]},
      {id: 'empty-figure', kind: 'figure', text: '', locator: 'PDF page 3', locations: []}]};
  const resultHash = hash(parsed);
  const source = {id: 'paper', title: 'Paper', sourceUri: 'fixture:original-pdf',
    sourceHash: parsed.sourceHash, parsed, resultHash, parseId: `evaluation-sciegqa:${resultHash}`};
  const question = {id: 'qa', paperId: 'paper', original: {query: ' Orion yield  '}, evidence: [
    {id: 'region', page: 2, kind: 'text', normalizedBbox: [.1, .2, .5, .6]}]};
  const correspondence = {id: 'qa', paperId: 'paper', evidence: [
    {publishedRegionId: 'region', status: 'visual-correspondence-candidate'}]};
  const structured = {pages: [{page: 2, coordinateFrame: {kind: 'pdf', viewport: {width: 100, height: 100}}}]};
  return {source, question, correspondence, structured};
}

test('region mapping requires original source, page, evidence type and region IoU', () => {
  const {source, question, correspondence, structured} = fixture();
  const mapped = mapSciegqaRegions(question, correspondence, source, structured);
  assert.deepEqual(mapped[0].matches, [{blockId: 'original-block', iou: 1}]);
  const image = structuredClone(question); image.evidence[0].kind = 'image';
  assert.equal(mapSciegqaRegions(image, correspondence, source, structured)[0].matches[0].blockId, 'original-figure');
  for (const alter of [q => {q.evidence[0].page = 3;}, q => {q.evidence[0].kind = 'table';},
    q => {q.evidence[0].normalizedBbox = [0, 0, 1, 1];}]) {
    const q = structuredClone(question); alter(q);
    assert.equal(mapSciegqaRegions(q, correspondence, source, structured)[0].status, 'no-compatible-production-block');
  }
  assert.throws(() => mapSciegqaRegions(question, correspondence, {...source, id: 'another'}, structured), /source_changed/);
  assert.throws(() => sciegqaRegionIou([0, 0, NaN, 1], [0, 0, 1, 1]), /bbox_invalid/);
});

test('unqualified source stays null; parse failure and absent blocks stay in candidate denominator', () => {
  const {source, question, correspondence, structured} = fixture();
  const unqualified = structuredClone(correspondence); unqualified.evidence[0].status = 'unqualified-source-region';
  const unmapped = mapSciegqaRegions(question, unqualified, source, structured);
  assert.equal(scoreSciegqaRegionRetrieval(unmapped, {hits: []}, {chunks: []}, source.id).metrics, null);
  const failed = mapSciegqaRegions(question, correspondence, null, null);
  assert.equal(failed[0].status, 'production-parse-failed');
  assert.equal(scoreSciegqaRegionRetrieval(failed, {hits: []}, {chunks: []}, source.id)
    .metrics.candidateRegionBlockRecallAt20, 0);
  const mapping = mapSciegqaRegions(question, correspondence, source, structured);
  const state = {chunks: [{chunkId: 'child', documentId: source.id, blockId: 'original-block'}]};
  assert.equal(scoreSciegqaRegionRetrieval(mapping, {hits: [{chunkId: 'child'}]}, state, source.id)
    .metrics.candidateRegionBlockRecallAt5, 1);
  assert.equal(scoreSciegqaRegionRetrieval(mapping, {hits: [{chunkId: 'child'}]}, state, 'other')
    .metrics.candidateRegionBlockRecallAt20, 0);
});

test('production IR/chunking SQL evidence and ranking reject source/span/locator/parent tampering', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-sciegqa-index-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const {source, question, correspondence, structured} = fixture(), projectId = sciegqaRetrievalProject;
  const packages = readJson(join(ROOT, 'package.json'));
  const entry = 'evaluation/runtime/production-sciegqa-retrieval.ts';
  const compiled = await build({entryPoints: [join(ROOT, entry)], bundle: true, format: 'esm',
    platform: 'node', target: 'node22', write: false, logLevel: 'silent',
    external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)]});
  // Keep the executable under the repository so native dependencies resolve,
  // exactly as the production benchmark does.
  const codeRoot = directory(join(ROOT, 'evaluation/.runtime/imports'), 'sciegqa');
  t.after(() => rmSync(codeRoot, {recursive: true, force: true}));
  const bundlePath = join(codeRoot, 'runtime/production-sciegqa-retrieval.mjs');
  mkdirSync(join(codeRoot, 'runtime'));
  mkdirSync(join(codeRoot, 'code/evaluation/runtime'), {recursive: true});
  const code = readFileSync(join(ROOT, entry));
  writeFileSync(join(codeRoot, 'code', entry), code);
  writeFileSync(bundlePath, compiled.outputFiles[0].contents);
  const execution = {codeHashes: {[entry]: sha256(code)},
    compiledBundleHashes: [{name: 'production-sciegqa-retrieval.mjs',
      sha256: sha256(compiled.outputFiles[0].contents)}]};
  const {openSciegqaRetrieval} = await import(pathToFileURL(bundlePath).href);
  const path = join(root, 'index.sqlite');
  let runtime;
  try {
    runtime = await openSciegqaRetrieval({path, projectId, sources: [source], signal: AbortSignal.timeout(120_000),
      config: sciegqaRetrievalConfig});
    const initial = readSciegqaIndex(path, [source], projectId);
    const request = sciegqaSearchRequest(question);
    const result = await runtime.search(request, AbortSignal.timeout(120_000));
    assert.ok(initial.chunks.some(c => c.parentChunkId !== c.chunkId));
    assert.ok(result.hits.length > 0);
    assert.equal(verifyRagSearch(result, initial, request, projectId), true);
    assert.equal(hash(readSciegqaIndex(path, [source], projectId)), hash(initial));
    const receipt = {questionId: question.id, publishedQuery: question.original.query, request, result,
      resultHash: hash(result), failure: null, elapsedMs: 1};
    const score = evaluateSciegqaQuery(question, correspondence, source, structured, receipt, initial);
    assert.equal(score.retrievalStatus, 'verified');
    assert.equal(score.metrics.candidateRegionBlockRecallAt20, 1);
    await t.test('query boundary, published bytes, result identity and failure receipts are bound', () => {
      for (const change of [r => {r.questionId = 'other';}, r => {r.publishedQuery = 'Orion yield';},
        r => {r.request.documentId = 'other';}, r => {r.request.query = question.original.query;},
        r => {r.resultHash = sha256('other');}, r => {r.elapsedMs = -1;},
        r => {delete r.failure;}, r => {r.failure = {code: 'failure'};}]) {
        const changed = structuredClone(receipt); change(changed);
        assert.throws(() => evaluateSciegqaQuery(question, correspondence, source, structured, changed, initial),
          /receipt_changed|result_changed|failure_invalid/);
      }
      for (const thrown of [undefined, null, 0, {code: 0}, '', 'search failed']) {
        const failed = {...receipt, result: null, resultHash: null, failure: sciegqaFailure(thrown)};
        const row = evaluateSciegqaQuery(question, correspondence, null, null, failed, initial);
        assert.equal(row.retrievalStatus, 'failed'); assert.equal(row.productionParseStatus, 'failed');
        assert.equal(row.metrics.candidateRegionBlockRecallAt20, 0);
        assert.deepEqual(summarizeSciegqaRetrieval([score, row]).candidateRegionBlockRecallAt20, .5);
      }
    });
    await t.test('self-consistent receipts from dense/rerank/changed-budget execution reject', () => {
      for (const change of [r => {r.vectorCount = 1;}, r => {r.embeddingModel = 'dense';},
        r => {r.ranking.candidateLimit = 100;}, r => {r.ranking.limit = 21;},
        r => {r.ranking.route.documentId = null;}, r => {r.ranking.embedding = {};},
        r => {r.ranking.reranker.status = 'succeeded';},
        r => {r.ranking.coverage.vector = 'results';},
        r => {r.ranking.candidates[0].vectorRank = 1;},
        r => {r.ranking.candidates[0].rerankScore = .9;}]) {
        const changed = structuredClone(receipt); change(changed.result); changed.resultHash = hash(changed.result);
        assert.throws(() => evaluateSciegqaQuery(question, correspondence, source, structured, changed, initial),
          /configuration_changed/);
      }
    });
    await t.test('saved executable/source bytes must match recorded identities', () => {
      verifySciegqaExecutionArtifacts(codeRoot, execution);
      writeFileSync(bundlePath, 'changed executable');
      assert.throws(() => verifySciegqaExecutionArtifacts(codeRoot, execution), /bundle_changed/);
      writeFileSync(bundlePath, compiled.outputFiles[0].contents);
      writeFileSync(join(codeRoot, 'code', entry), 'changed source');
      assert.throws(() => verifySciegqaExecutionArtifacts(codeRoot, execution), /code_changed/);
      writeFileSync(join(codeRoot, 'code', entry), code);
      assert.throws(() => verifySciegqaExecutionArtifacts(codeRoot, {...execution, compiledBundleHashes: []}),
        /identity_missing/);
    });
    const altered = structuredClone(result); altered.hits[0].content = 'fabricated';
    assert.throws(() => verifyRagSearch(altered, initial, request, projectId), /hit_invalid/);
    await runtime.close(); runtime = null;
    await t.test('derived source/result identity cannot change', () => {
      const changed = structuredClone(source); changed.parsed.blocks[0].text = 'fabricated';
      assert.throws(() => readSciegqaIndex(path, [changed], projectId), /source_changed/);
    });
    for (const [name, sql] of [
      ['locator', "UPDATE research_knowledge_chunks SET locator='invented' WHERE id=?"],
      ['span', 'UPDATE research_knowledge_chunk_structure SET start_utf16=start_utf16+1 WHERE chunk_id=?'],
      ['parent', 'UPDATE research_knowledge_chunk_structure SET parent_chunk_id=NULL WHERE chunk_id=?'],
    ]) await t.test(`changed ${name} rejects`, () => {
      const alteredPath = join(root, `${name}.sqlite`); copyFileSync(path, alteredPath);
      const db = new Database(alteredPath);
      db.prepare(sql).run(initial.chunks.find(c => c.parentChunkId !== c.chunkId).chunkId); db.close();
      assert.throws(() => readSciegqaIndex(alteredPath, [source], projectId),
        /span_changed|parent_missing|parent_changed/);
    });
  } finally {
    if (runtime) await runtime.close();
  }
});

test('baseline header retains failed papers and rejects fabricated qualification or source identity', () => {
  const {source} = fixture();
  const inputsSource = {sources: [source], verifiedPdf: {failedPapers: 44}, cohort: {sourceLockHash: 'source'},
    correspondence: {manifestHash: 'manifest', inventoryHash: 'inventory'}};
  const {parsed, ...identity} = source;
  const inputs = {nodeVersion: process.version, config: sciegqaRetrievalConfig,
    contract: sciegqaRegionRetrievalContract, sourceIdentities: [identity],
    pdfVerificationHash: hash(inputsSource.verifiedPdf),
    correspondenceManifestHash: 'manifest', correspondenceInventoryHash: 'inventory',
    codeHashes: {runtime: sha256('runtime')}};
  const report = {schemaVersion: 1, kind: 'scientific-sciegqa-production-pdf-bm25-component-baseline',
    status: 'measured-region-observations', papers: 45, queries: 225, parsedPapers: 1, failedPapers: 44,
    sourceLockHash: 'source', cohortHash: hash(inputsSource.cohort), nodeVersion: process.version,
    config: inputs.config, codeHashes: inputs.codeHashes,
    providerCalls: 0, storedEmbeddings: 0, embeddingCost: null, qualityMetrics: null, scientificBaselineReady: false};
  verifySciegqaRetrievalHeader(report, inputs, inputsSource);
  for (const change of [r => {r.queries = 224;}, r => {r.papers = 44;}, r => {r.failedPapers = 0;},
    r => {r.parsedPapers = 45;}, r => {r.sourceLockHash = 'other';}, r => {r.cohortHash = 'other';},
    r => {r.providerCalls = 1;}, r => {r.storedEmbeddings = 1;}, r => {r.embeddingCost = 0;},
    r => {r.qualityMetrics = {accuracy: 1};}, r => {r.scientificBaselineReady = true;},
    r => {r.nodeVersion = 'other';}]) {
    const changed = structuredClone(report); change(changed);
    assert.throws(() => verifySciegqaRetrievalHeader(changed, inputs, inputsSource), /run_unqualified/);
  }
  const changed = structuredClone(inputs); changed.sourceIdentities[0].sourceHash = 'other';
  assert.throws(() => verifySciegqaRetrievalHeader(report, changed, inputsSource), /run_unqualified/);
});
