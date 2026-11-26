import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hash, readJson, ROOT, sha256 } from '../lib/common.mjs';
import { resolveScientificEvidenceGold } from '../lib/scientific-evidence-resolution.mjs';
import { scoreScientificEvidence } from '../lib/scientific-evidence-scoring.mjs';
import { observeScientificEvidenceSources, resolveScientificEvidenceRun } from '../adapters/scientific-evidence-resolution.mjs';
import { readSciegqaIndex } from '../adapters/scientific-public/sciegqa-retrieval.mjs';
import { sciegqaRetrievalConfig, sciegqaRetrievalProject } from '../adapters/scientific-public/sciegqa-retrieval-run.mjs';
import { scientificEvidenceResolutionArguments } from '../../scripts/resolve-scientific-evidence.mjs';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

// Entirely fabricated engineering data. No genuine review or scientific gold.
function fixture() {
  const projectId = sciegqaRetrievalProject, paperId = 'synthetic-paper', text = ' A 😀e\u0301 = 2 ';
  const sourceHash = hash('synthetic PDF'), ref = {
    parseId: 'synthetic-parse', parseHash: hash('synthetic-result'), parserFingerprint: hash('synthetic-parser')
  };
  const range = { projectId, paperId, sourceHash, ...ref, blockId: 'production-block', page: 1,
    start: 0, end: text.length };
  const source = { projectId, paperId, sourceHash, status: 'parsed', failureCode: null, parseRef: ref,
    blocks: [{ id: 'production-block', blockId: 'production-block', kind: 'text', page: 1,
      bbox: [.1, .2, .8, .4], text, indexedRanges: [{ chunkId: 'parent', range }] }] };
  const annotation = { schemaVersion: 1, annotationVersion: 'scientific-gold-v1', paperId, sourceHash,
    parseRef: null, coordinateSystem: 'TOPLEFT_NORMALIZED', pages: [{ page: 1, transcript: text }],
    blocks: [{ blockId: 'independent-gold-block', kind: 'text', page: 1, bbox: [.1, .2, .8, .4],
      text, readingOrder: 0 }], expectedSections: [], expectedTables: [], expectedFigures: [],
    expectedEquations: [], expectedCitations: [], review: { status: 'draft', annotations: [], arbitration: null } };
  const start = text.indexOf('😀'), end = start + '😀e\u0301'.length;
  const query = { id: 'synthetic-query', category: 'paper-qa', query: 'Synthetic equation?',
    targetPaperIds: [paperId], targetBlockIds: ['independent-gold-block'], targetTableIds: [],
    targetFigureIds: [], targetEquationIds: [], expectedEvidenceSpans: [{
      id: 'synthetic-span', paperId, sourceHash, blockId: 'independent-gold-block', page: 1,
      start, end, quote: text.slice(start, end), relevance: 3
    }], expectedAnswer: 'Synthetic only', answerable: true, unanswerableReason: null,
    review: { status: 'draft', annotations: [], arbitration: null } };
  return { projectId, source, annotation, query, range };
}
const resolveFixture = f => resolveScientificEvidenceGold(f.query, [f.annotation], [f.source], f.projectId);
const mapped = f => resolveFixture(f).gold.spans[0].mapping;

test('exact independent block resolution retains original IDs/quote hashes and UTF-16 offsets into scoring', () => {
  const f = fixture(), result = resolveFixture(f), span = result.gold.spans[0];
  assert.equal(span.blockId, 'independent-gold-block');
  assert.deepEqual(span.mapping.ranges, [{ ...f.range, start: span.start, end: span.end }]);
  assert.equal(result.resolutions[0].originalQuoteHash, hash('😀e\u0301'));
  assert.equal(result.resolutions[0].matchedId, 'production-block');
  assert.equal(result.scientificBaselineReady, false);
  const channel = { status: 'verified', reason: null, items: [{
    id: 'actual-item', locators: [{ id: 'actual-location', status: 'verified', reason: null,
      range: span.mapping.ranges[0] }]
  }] };
  const score = scoreScientificEvidence({ schemaVersion: 1, gold: result.gold, observation: {
    queryId: f.query.id, ranking: channel, context: channel,
    unsupportedAnswerEvidence: { status: 'unmeasured', unsupportedPositive: null }
  } });
  assert.equal(score.metrics.recallAt5.value, 1);
  assert.equal(score.metrics.spanRecall.value, 1);
});

test('quote/page/target tampering and duplicate annotations or sources cannot form mappings', () => {
  for (const change of [f => {f.query.expectedEvidenceSpans[0].quote = 'changed';},
    f => {f.query.expectedEvidenceSpans[0].end = 1000;},
    f => {f.query.expectedEvidenceSpans[0].page = 2;},
    f => {f.query.targetPaperIds = ['other'];}, f => {f.query.targetBlockIds = ['other'];}]) {
    const f = fixture(); change(f);
    assert.throws(() => resolveFixture(f), /gold_quote_or_target_changed/);
  }
  const f = fixture();
  assert.throws(() => resolveScientificEvidenceGold(f.query, [f.annotation, f.annotation], [f.source], f.projectId),
    /duplicate_annotation/);
  assert.throws(() => resolveScientificEvidenceGold(f.query, [f.annotation], [f.source, f.source], f.projectId),
    /duplicate_source/);
  f.annotation.blocks.push(structuredClone(f.annotation.blocks[0]));
  assert.throws(() => resolveFixture(f), /duplicate_gold_block/);
  const wrongId = fixture(); wrongId.source.blocks[0].id = 'another-id';
  assert.throws(() => resolveFixture(wrongId), /block_identity_mismatch/);
});

test('OCR edits, normalization, geometry shifts, wrong page/kind and split blocks stay unresolved', () => {
  for (const change of [s => {s.blocks[0].text = s.blocks[0].text.normalize('NFC');},
    s => {s.blocks[0].text += ' ';}, s => {s.blocks[0].bbox[0] = .100001;},
    s => {s.blocks[0].page = 2; s.blocks[0].indexedRanges[0].range.page = 2;},
    s => {s.blocks[0].kind = 'caption';}, s => {s.blocks[0].text = s.blocks[0].text.slice(0, 5);
      s.blocks[0].indexedRanges[0].range.end = 5;}]) {
    const f = fixture(); change(f.source);
    f.source.blocks[0].indexedRanges[0].range.end = Math.min(
      f.source.blocks[0].indexedRanges[0].range.end, f.source.blocks[0].text.length);
    assert.equal(mapped(f).status, 'unresolved');
    assert.equal(mapped(f).reason, 'no-exact-block-correspondence');
  }
});

test('duplicate exact regions remain ambiguous even when only one is indexed', () => {
  const f = fixture(), copy = structuredClone(f.source.blocks[0]);
  copy.id = 'rich-duplicate'; copy.blockId = null; copy.indexedRanges = [];
  f.source.blocks.push(copy);
  assert.equal(mapped(f).status, 'unresolved');
  assert.equal(mapped(f).reason, 'ambiguous-exact-block-correspondence');
});

test('verified failure and exact rich-only objects retain absent gold, not positive mappings', () => {
  const f = fixture();
  f.source.status = 'failed'; f.source.failureCode = 'synthetic-failure';
  f.source.blocks = []; f.source.parseRef = null;
  assert.equal(mapped(f).status, 'absent');
  assert.equal(mapped(f).reason, 'production-parse-failed:synthetic-failure');
  const rich = fixture(); rich.source.blocks[0].blockId = null; rich.source.blocks[0].indexedRanges = [];
  assert.equal(mapped(rich).status, 'absent');
  assert.equal(mapped(rich).reason, 'exact-object-not-fully-indexed');
});

test('missing source, version changes and captured parse mismatch remain unresolved', () => {
  const f = fixture();
  assert.equal(resolveScientificEvidenceGold(f.query, [f.annotation], [], f.projectId)
    .gold.spans[0].mapping.reason, 'production-source-unavailable');
  f.source.sourceHash = hash('new PDF'); f.source.blocks[0].indexedRanges[0].range.sourceHash = f.source.sourceHash;
  assert.equal(mapped(f).reason, 'production-source-version-mismatch');
  const captured = fixture(); captured.annotation.parseRef = { ...captured.source.parseRef, parseId: 'old-parse' };
  assert.equal(mapped(captured).reason, 'captured-parse-mismatch');
  captured.annotation.parseRef = captured.source.parseRef;
  // Captured gold uses the actual captured block ID.
  assert.equal(mapped(captured).reason, 'no-exact-block-correspondence');
  captured.annotation.blocks[0].blockId = 'production-block';
  captured.query.expectedEvidenceSpans[0].blockId = 'production-block';
  captured.query.targetBlockIds = ['production-block'];
  assert.equal(mapped(captured).status, 'mapped');
});

test('multiple indexed children may cover the span, but any gap preserves an absent denominator', () => {
  const f = fixture(), span = f.query.expectedEvidenceSpans[0];
  f.source.blocks[0].indexedRanges = [
    { chunkId: 'left', range: { ...f.range, end: span.start + 2 } },
    { chunkId: 'right', range: { ...f.range, start: span.start + 2 } }
  ];
  assert.equal(mapped(f).status, 'mapped');
  f.source.blocks[0].indexedRanges[1].range.start++;
  assert.equal(mapped(f).status, 'absent');
});

test('source/index project, parse, block, range and duplicate chunk mismatches reject', () => {
  for (const change of [s => {s.projectId = 'other';},
    s => {s.blocks[0].indexedRanges[0].range.parseHash = hash('changed');},
    s => {s.blocks[0].indexedRanges[0].range.blockId = 'other';},
    s => {s.blocks[0].indexedRanges[0].range.end++;},
    s => {s.blocks[0].indexedRanges.push(s.blocks[0].indexedRanges[0]);}]) {
    const f = fixture(); change(f.source);
    assert.throws(() => resolveFixture(f), /project_mismatch|index_identity_mismatch|duplicate_chunk/);
  }
});

test('unanswerable queries preserve empty spans without deriving an answer judgment', () => {
  const f = fixture(); f.query.category = 'unanswerable'; f.query.answerable = false;
  f.query.expectedEvidenceSpans = []; f.query.expectedAnswer = null; f.query.unanswerableReason = 'Synthetic only';
  const result = resolveFixture(f);
  assert.deepEqual(result.gold.spans, []);
  assert.equal(result.scientificBaselineReady, false);
});

test('host observations use actual production SQLite indexing and reject self-consistent chunk tampering', async t => {
  const f = fixture(), root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-evidence-resolution-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const text = f.source.blocks[0].text.repeat(500);
  const block = { id: 'production-block', kind: 'paragraph', text, imagePath: null, locator: 'PDF page 1',
    locations: [{ page: 1, bbox: [10, 20, 80, 40], coordinateOrigin: 'TOPLEFT' }] };
  const parsed = { sourceHash: f.source.sourceHash, parserVersion: 'synthetic-parser',
    parserFingerprint: f.source.parseRef.parserFingerprint, pageCount: 1, blocks: [block], assets: [] };
  const resultHash = hash(parsed), source = { id: f.source.paperId, title: 'Synthetic', sourceUri: 'fixture:pdf',
    sourceHash: parsed.sourceHash, parsed, resultHash, parseId: `evaluation-sciegqa:${resultHash}` };
  const structured = { ...parsed, coordinateFrameContractVersion: 1, pages: [{
    page: 1, text, regions: [], coordinateFrame: { kind: 'pdf', page: 1, unit: 'raster-pixel',
      coordinateOrigin: 'TOPLEFT', width: 100, height: 100, viewport: { width: 100, height: 100, scale: 1,
        rotation: 0, userUnit: 1, viewBox: [0, 0, 100, 100], transform: [1, 0, 0, -1, 0, 100] } }
  }] };
  const row = { datasetPaperId: source.id, sourceHash: source.sourceHash, parserFingerprint: parsed.parserFingerprint,
    pageCount: 1, status: 'parsed', failure: null, artifacts: [] };
  const packageJson = readJson(join(ROOT, 'package.json'));
  const { openSciegqaRetrieval } = await importTypeScriptModule(join(ROOT, 'evaluation/runtime/production-sciegqa-retrieval.ts'),
    { platform: 'node', external: [...Object.keys(packageJson.dependencies), ...Object.keys(packageJson.devDependencies)],
      tempDir: join(ROOT, 'evaluation/.runtime/imports') });
  const path = join(root, 'research.sqlite');
  const runtime = await openSciegqaRetrieval({ path, sources: [source], projectId: f.projectId,
    config: sciegqaRetrievalConfig, signal: AbortSignal.timeout(120_000) });
  try {
    const state = readSciegqaIndex(path, [source], f.projectId), before = hash(state);
    const sourceInputs = { sources: [source], structures: new Map([[source.id, structured]]) };
    const observations = observeScientificEvidenceSources(sourceInputs, state, { rows: [row] });
    assert.equal(observations[0].blocks[0].indexedRanges.length, state.chunks.length);
    assert.ok(state.chunks.some(c => c.parentChunkId !== c.chunkId));
    assert.equal(observations[0].parseRef.parseHash, resultHash);
    assert.equal(hash(readSciegqaIndex(path, [source], f.projectId)), before);
    for (const change of [s => {s.chunks[0].chunkHash = hash('wrong');},
      s => {s.chunks[0].blockId = 'not-a-block';}, s => {s.chunks[0].parseId = 'old-parse';}]) {
      const altered = structuredClone(state); change(altered);
      assert.throws(() => observeScientificEvidenceSources(sourceInputs, altered, { rows: [row] }),
        /index_changed|index_block_unresolved/);
    }
  } finally { await runtime.close(); }
});

test('gold host mode fails closed before reading missing runs and CLI persists blocked reports without overwrite', async t => {
  const manifestPath = join(ROOT, 'evaluation/corpora/scientific-rag/manifest.json');
  const report = await resolveScientificEvidenceRun({ runRoot: '/missing-synthetic-run', manifestPath });
  assert.equal(report.status, 'blocked'); assert.equal(report.resolutions, null);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-evidence-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'blocked.json'), args = ['scripts/resolve-scientific-evidence.mjs',
    '--run', '/missing-synthetic-run', '--output', output];
  const cli = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr);
  assert.equal(readJson(output).status, 'blocked');
  const bytes = readFileSync(output), overwrite = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(overwrite.status, 1); assert.match(overwrite.stderr, /EEXIST/);
  assert.deepEqual(readFileSync(output), bytes);
  for (const extra of [['--observe', '--manifest', 'x'], ['--run', 'x'], ['--unknown'], ['--manifest']]) {
    assert.throws(() => scientificEvidenceResolutionArguments(['--run', 'x', '--output', 'y', ...extra]));
  }
});


test('v2 refusal condition spans remain auditable without entering positive evidence scoring', () => {
  const f = fixture(), span = f.query.expectedEvidenceSpans[0];
  Object.assign(f.query, { schemaVersion: 2, category: 'unanswerable', answerable: false,
    answerability: 'conditions_not_comparable', expectedAnswer: null, unanswerableReason: 'Synthetic split missing',
    requiredConditions: [{ id: 'metric', paperId: span.paperId, field: 'metric', status: 'known',
      value: 'Synthetic metric', evidenceSpanIds: [span.id] }, { id: 'split', paperId: span.paperId,
      field: 'split', status: 'unknown', value: null, evidenceSpanIds: [] }] });
  const result = resolveFixture(f);
  assert.deepEqual(result.gold.spans, []);
  assert.deepEqual(result.resolutions, []);
  assert.equal(result.conditionResolutions[0].span.mapping.status, 'mapped');
  assert.equal(result.conditionResolutions[0].originalQuoteHash, hash(span.quote));
  const score = scoreScientificEvidence({ schemaVersion: 1, gold: result.gold, observation: {
    queryId: f.query.id, ranking: { status: 'verified', reason: null, items: [] },
    context: { status: 'verified', reason: null, items: [] },
    unsupportedAnswerEvidence: { status: 'unmeasured', unsupportedPositive: null }
  } });
  assert.equal(score.metrics.recallAt5.value, null);
  f.query.requiredConditions[0].evidenceSpanIds = [];
  assert.throws(() => resolveFixture(f), /unanswerable_condition_evidence_missing/);
});
