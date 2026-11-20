import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hash, ROOT } from '../lib/common.mjs';
import { resolveScientificEvidenceGold } from '../lib/scientific-evidence-resolution.mjs';
import { bindScientificEvidenceQuery, validateScientificQuerySelections,
  summarizeScientificQueryBindings } from '../lib/scientific-query-binding.mjs';
import { scoreScientificRetrievalRun } from '../adapters/scientific-retrieval.mjs';
import { scientificRetrievalScoringArguments } from '../../scripts/score-scientific-retrieval.mjs';

// Explicitly fabricated engineering declarations, with no reviewer identity,
// scientific judgment or full-corpus qualification.
function fixture() {
  const projectId = 'synthetic-project', paperId = 'synthetic-paper', text = ' Synthetic 😀 equation = 42. ';
  const sourceHash = hash('synthetic-original'), parseRef = { parseId: 'synthetic-parse',
    parseHash: hash('synthetic-parse'), parserFingerprint: hash('synthetic-parser') };
  const range = { projectId, paperId, sourceHash, ...parseRef, blockId: 'production-block',
    page: 1, start: 0, end: text.length };
  const sources = [{ projectId, paperId, sourceHash, parseRef, status: 'parsed', failureCode: null,
    blocks: [{ id: 'production-block', blockId: 'production-block', page: 1, kind: 'text',
      text, bbox: [.1, .1, .9, .3], indexedRanges: [{ chunkId: 'synthetic-chunk', range }] }] }];
  const annotation = { schemaVersion: 1, annotationVersion: 'scientific-gold-v1', paperId, sourceHash,
    parseRef: null, coordinateSystem: 'TOPLEFT_NORMALIZED', pages: [{ page: 1, transcript: text }],
    blocks: [{ blockId: 'independent-block', page: 1, kind: 'text', bbox: [.1, .1, .9, .3],
      text, readingOrder: 0 }], expectedSections: [], expectedTables: [], expectedFigures: [],
    expectedEquations: [], expectedCitations: [], review: { status: 'draft', annotations: [], arbitration: null } };
  const query = { id: 'independent-query', query: ' Synthetic equation? ', category: 'paper-qa',
    targetPaperIds: [paperId], targetBlockIds: ['independent-block'], targetTableIds: [],
    targetFigureIds: [], targetEquationIds: [], expectedEvidenceSpans: [{ id: 'independent-span',
      paperId, sourceHash, blockId: 'independent-block', page: 1, start: 1, end: text.length - 1,
      quote: text.slice(1, -1), relevance: 3 }], expectedAnswer: 'Synthetic only', answerable: true,
    unanswerableReason: null, review: { status: 'draft', annotations: [], arbitration: null } };
  const receipt = { questionId: 'published-query', publishedQuery: 'Synthetic equation?',
    request: { projectId, documentId: paperId, query: 'Synthetic equation?', limit: 20 },
    result: { synthetic: true }, resultHash: hash('synthetic'), failure: null, elapsedMs: 1 };
  const channel = { status: 'verified', reason: null, items: [{ id: 'item', locators: [{
    id: 'location', status: 'verified', reason: null, range
  }] }] };
  const observation = { queryId: receipt.questionId, ranking: channel, context: channel,
    unsupportedAnswerEvidence: { status: 'unmeasured', unsupportedPositive: null } };
  const resolution = resolveScientificEvidenceGold(query, [annotation], sources, projectId);
  const entry = { queryId: query.id, queryHash: hash(query), status: 'selected',
    publishedQueryId: receipt.questionId, savedReceiptHash: hash(receipt) };
  return { query, resolution, sources, papers: [{ paperId, sourceHash }], receipt, observation, entry };
}

test('explicit same-request binding retains independent gold IDs and the original observation digest', () => {
  const f = fixture(), before = structuredClone(f), row = bindScientificEvidenceQuery(f);
  assert.equal(row.status, 'bound');
  assert.equal(row.originalObservationHash, hash(f.observation));
  assert.equal(row.input.observation.queryId, f.query.id);
  assert.equal(row.input.gold.spans[0].blockId, 'independent-block');
  assert.deepEqual(f, before);
  const summary = summarizeScientificQueryBindings([row]);
  assert.equal(summary.scores.rows[0].metrics.recallAt5.value, 1);
  assert.equal(summary.scores.rows[0].metrics.spanRecall.value, 1);
  assert.equal(summary.scientificBaselineReady, false);
});

test('wrong text/ID/receipt/project or self-consistent gold revision edits cannot bind', () => {
  for (const alter of [
    f => { f.receipt.publishedQuery = 'Other question?'; },
    f => { f.receipt.request.query = 'synthetic equation?'; },
    f => { f.receipt.questionId = 'other-query'; },
    f => { f.receipt.elapsedMs++; },
    f => { f.receipt.request.projectId = 'other-project'; },
    f => { f.query.expectedAnswer = 'changed'; f.entry.queryHash = hash(f.query); },
    f => { f.resolution.gold.spans[0].mapping.ranges[0].start++; }
  ]) {
    const f = fixture(); alter(f);
    // Rehashing the selected receipt cannot bypass semantic request matching.
    if (f.receipt.request.projectId === 'other-project' || f.receipt.request.query[0] === 's'
      || f.receipt.publishedQuery === 'Other question?') f.entry.savedReceiptHash = hash(f.receipt);
    assert.throws(() => bindScientificEvidenceQuery(f), /scientific_query_binding_/);
  }
});

test('source versions and wrong-paper/parse observations reject despite coherent receipt hashes', () => {
  for (const alter of [
    f => { f.papers[0].sourceHash = hash('old source'); },
    f => { f.observation.ranking.items[0].locators[0].range.parseHash = hash('old parse'); },
    f => { f.observation.ranking.items[0].locators[0].range.paperId = 'outside'; },
    f => { f.sources[0].sourceHash = hash('other source'); }
  ]) {
    const f = fixture(); alter(f);
    assert.throws(() => bindScientificEvidenceQuery(f), /source_version_changed|observation_source_changed|gold_resolution_changed/);
  }
});

test('missing selection and cross-paper scope retain each query with NA channels in the summary', () => {
  const first = fixture();
  first.entry = { queryId: first.query.id, queryHash: hash(first.query), status: 'unavailable',
    reason: 'no-published-saved-request' };
  first.receipt = null; first.observation = null;
  const cross = fixture();
  cross.query.id = 'cross-query'; cross.query.category = 'cross-paper';
  cross.query.targetPaperIds.push('second-paper');
  const second = structuredClone(cross.sources[0]); second.paperId = 'second-paper'; second.blocks = [];
  cross.sources.push(second); cross.papers.push({ paperId: second.paperId, sourceHash: second.sourceHash });
  cross.resolution.queryHash = hash(cross.query); cross.resolution.sourceObservationHash = hash(cross.sources);
  cross.resolution.gold.queryId = cross.query.id; cross.resolution.gold.category = cross.query.category;
  cross.entry.queryId = cross.query.id; cross.entry.queryHash = hash(cross.query);
  const rows = [bindScientificEvidenceQuery(first), bindScientificEvidenceQuery(cross)];
  const summary = summarizeScientificQueryBindings(rows);
  assert.deepEqual(summary.counts, { queries: 2, bound: 0, unbound: 2 });
  assert.equal(summary.scores.overall.metrics.recallAt5.value, null);
  assert.equal(summary.scores.overall.metrics.recallAt5.naQueries, 2);
  assert.match(rows[1].reason, /target-scope/);
});

test('binding cohort requires all original query digests/order and forbids reused published requests', () => {
  const f = fixture(), bindings = { schemaVersion: 1, kind: 'scientific-explicit-saved-query-bindings',
    corpusInputDigest: hash('corpus'), savedIndexHash: hash('index'), contextReportHash: null, entries: [f.entry] };
  const validate = b => validateScientificQuerySelections(b, [f.query], hash('corpus'), hash('index'), null);
  assert.deepEqual(validate(bindings), bindings);
  for (const alter of [b => { b.entries[0].queryHash = hash('old'); }, b => { b.entries.push(b.entries[0]); },
    b => { b.contextReportHash = hash('context'); }, b => { b.savedIndexHash = hash('old'); }]) {
    const b = structuredClone(bindings); alter(b); assert.throws(() => validate(b), /scientific_query_binding_/);
  }
  const next = structuredClone(f.query); next.id = 'second-query';
  const duplicate = { ...bindings, entries: [f.entry, { ...f.entry, queryId: next.id, queryHash: hash(next) }] };
  assert.throws(() => validateScientificQuerySelections(duplicate, [f.query, next],
    hash('corpus'), hash('index'), null), /reused_saved_query/);
});

test('historical missing context and failed ranking remain NA; no unsupported answer is inferred', () => {
  const f = fixture();
  f.observation.context = { status: 'unavailable', reason: 'historical-context-not-recorded', items: [] };
  const first = summarizeScientificQueryBindings([bindScientificEvidenceQuery(f)]).scores.rows[0];
  assert.equal(first.metrics.recallAt5.value, 1); assert.equal(first.metrics.spanRecall.value, null);
  f.observation.ranking = { status: 'failed', reason: 'actual-search-failure', items: [] };
  const failed = summarizeScientificQueryBindings([bindScientificEvidenceQuery(f)]).scores.rows[0];
  assert.equal(failed.metrics.recallAt5.value, null);
  assert.equal(failed.contextStatus, 'unavailable');
});

test('host and actual CLI reject the unqualified current corpus before nonexistent run/binding/context reads', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-query-binding-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = join(root, 'nonexistent');
  const report = await scoreScientificRetrievalRun({ runRoot: missing, bindingsPath: missing, contextPath: missing });
  assert.equal(report.status, 'blocked'); assert.equal(report.scores, null);
  await assert.rejects(scoreScientificRetrievalRun({ runRoot: missing, manifestPath: null,
    bindingsPath: missing, contextPath: missing }), /manifest_required/);
  const output = join(root, 'blocked.json');
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/score-scientific-retrieval.mjs'),
    '--run', missing, '--bindings', missing, '--context', missing, '--output', output], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 2, run.stderr);
  const saved = JSON.parse(readFileSync(output));
  assert.equal(saved.status, 'blocked'); assert.equal(saved.scientificBaselineReady, false);
  const before = readFileSync(output);
  const again = spawnSync(process.execPath, [join(ROOT, 'scripts/score-scientific-retrieval.mjs'),
    '--run', missing, '--bindings', missing, '--output', output], { encoding: 'utf8', cwd: ROOT });
  assert.equal(again.status, 1); assert.match(again.stderr, /EEXIST/);
  assert.deepEqual(readFileSync(output), before);
});

test('CLI rejects malformed arguments, source overlap and symlink/dangling ancestors', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-binding-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const args = ['--run', join(root, 'run'), '--bindings', join(root, 'bindings.json'),
    '--output', join(root, 'new.json')];
  assert.equal(scientificRetrievalScoringArguments(args).output, join(root, 'new.json'));
  for (const bad of [[], args.slice(0, -1), [...args, '--unknown', 'x'], [...args, '--run', 'x']]) {
    assert.throws(() => scientificRetrievalScoringArguments(bad), /arguments_invalid/);
  }
  assert.throws(() => scientificRetrievalScoringArguments([...args.slice(0, -1), join(root, 'run', 'new.json')]),
    /overlaps_input/);
  const link = join(root, 'link'); symlinkSync(tmpdir(), link);
  const dangling = join(root, 'dangling'); symlinkSync(join(root, 'absent'), dangling);
  for (const p of [link, dangling]) assert.throws(() =>
    scientificRetrievalScoringArguments([...args.slice(0, -1), join(p, 'new.json')]), /output_link/);
  writeFileSync(join(root, 'new.json'), 'preserved');
  assert.throws(() => scientificRetrievalScoringArguments(args), /EEXIST/);
});
