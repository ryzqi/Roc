import assert from 'node:assert/strict';
import test from 'node:test';
import { hash } from '../lib/common.mjs';
import { scoreScientificEvidence, summarizeScientificEvidence } from '../lib/scientific-evidence-scoring.mjs';

// Entirely fabricated engineering fixtures. They are neither human gold nor
// model/runtime observations and are never saved as scientific baseline data.
const target = () => ({
  projectId: 'test-project', paperId: 'test-paper', sourceHash: hash('fabricated-source'),
  parseId: 'test-parse', parseHash: hash('fabricated-parse'), parserFingerprint: hash('fabricated-parser'),
  blockId: 'production-block', page: 1
});
const range = (start = 0, end = 10, change = {}) => ({ ...target(), start, end, ...change });
const gold = (id = 'gold-1', relevance = 3, ranges = [range()]) => ({
  id, paperId: target().paperId, sourceHash: target().sourceHash, blockId: id,
  page: 1, start: 0, end: 10, relevance, parseRef: null,
  mapping: { status: 'mapped', reason: null, ranges }
});
const hit = (id, ranges = [range()]) => ({
  id, locators: ranges.map((r, i) => ({ id: `${id}-locator-${i}`, status: 'verified', reason: null, range: r }))
});
const input = () => ({
  schemaVersion: 1,
  gold: { queryId: 'query-1', projectId: 'test-project', category: 'paper-qa', answerable: true, spans: [gold()] },
  observation: {
    queryId: 'query-1',
    ranking: { status: 'verified', reason: null, items: [hit('rank-1')] },
    context: { status: 'verified', reason: null, items: [] },
    unsupportedAnswerEvidence: { status: 'unmeasured', unsupportedPositive: null }
  }
});
const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);

test('full ranking coverage does not invent actual context reads', () => {
  const score = scoreScientificEvidence(input());
  for (const key of ['recallAt5', 'recallAt10', 'recallAt20', 'mrrAt10', 'ndcgAt10']) {
    assert.equal(score.metrics[key].value, 1);
  }
  assert.equal(score.metrics.spanRecall.value, 0);
  assert.deepEqual(score.contextCoveredIds, []);
  assert.equal(score.metrics.rankingLocatorAccuracy.value, 1);
  assert.equal(score.metrics.contextLocatorAccuracy.value, null);
  assert.equal(score.metrics.locatorAccuracy.value, 1);
  assert.equal(score.scientificBaselineReady, false);
  assert.equal(score.status, 'calculated-unqualified');
});

test('adjacent child ranges complete at the second rank; actual read truncation remains partial', () => {
  const value = input();
  value.observation.ranking.items = [hit('a', [range(0, 5)]), hit('b', [range(5, 10)])];
  value.observation.context.items = [hit('read', [range(0, 9)])];
  const score = scoreScientificEvidence(value);
  assert.deepEqual(score.completionRanks, [{ id: 'gold-1', firstRank: 2 }]);
  assert.equal(score.metrics.mrrAt10.value, .5);
  almost(score.metrics.ndcgAt10.value, 1 / Math.log2(3));
  assert.equal(score.metrics.spanRecall.value, 0);
  value.observation.context.items.push(hit('read-end', [range(9, 10)]));
  assert.equal(scoreScientificEvidence(value).metrics.spanRecall.value, 1);
});

test('gaps, overlaps and duplicate hits cannot inflate full-span coverage', () => {
  const value = input();
  value.observation.ranking.items = [hit('a', [range(0, 4)]), hit('b', [range(5, 10)]),
    hit('duplicate-content', [range(0, 4)])];
  assert.equal(scoreScientificEvidence(value).metrics.recallAt20.value, 0);
  value.observation.ranking.items.push(hit('gap', [range(4, 5)]));
  const score = scoreScientificEvidence(value);
  assert.equal(score.metrics.recallAt5.value, 1);
  assert.equal(score.metrics.mrrAt10.value, .25);
});

test('every required block fragment must be recovered for a split gold span', () => {
  const value = input();
  value.gold.spans[0].mapping.ranges = [range(0, 4), range(1, 7, { blockId: 'second-block' })];
  assert.equal(scoreScientificEvidence(value).metrics.recallAt20.value, 0);
  value.observation.ranking.items.push(hit('second', [range(1, 7, { blockId: 'second-block' })]));
  assert.equal(scoreScientificEvidence(value).metrics.recallAt20.value, 1);
});

test('wrong project/paper/source/parse/fingerprint/block/page never supplies missing coverage', () => {
  const changes = [
    { projectId: 'other-project' }, { paperId: 'other-paper' }, { sourceHash: hash('other-source') },
    { parseId: 'other-parse' }, { parseHash: hash('other-parse-bytes') },
    { parserFingerprint: hash('other-parser') }, { blockId: 'other-block' }, { page: 2 }
  ];
  for (const change of changes) {
    const value = input();
    value.observation.ranking.items = [hit('a', [range(0, 5)]), hit('b', [range(5, 10, change)])];
    assert.equal(scoreScientificEvidence(value).metrics.recallAt20.value, 0, JSON.stringify(change));
  }
});

test('gold mappings reject a different source, page, project or captured parse and mixed parses', () => {
  for (const change of [{ projectId: 'other' }, { paperId: 'other' }, { sourceHash: hash('other') }, { page: 2 }]) {
    const value = input(); Object.assign(value.gold.spans[0].mapping.ranges[0], change);
    assert.throws(() => scoreScientificEvidence(value), /gold_mapping_identity_mismatch/);
  }
  const value = input(), { parseId, parseHash, parserFingerprint } = target();
  value.gold.spans[0].parseRef = { parseId, parseHash, parserFingerprint };
  assert.equal(scoreScientificEvidence(value).metrics.recallAt5.value, 1);
  value.gold.spans[0].parseRef.parseId = 'stale-parse';
  assert.throws(() => scoreScientificEvidence(value), /gold_mapping_identity_mismatch/);
  const mixed = input();
  mixed.gold.spans[0].mapping.ranges.push(range(10, 20, { parseId: 'another-parse' }));
  assert.throws(() => scoreScientificEvidence(mixed), /gold_mapping_mixed_parses/);
});

test('UTF-16 ranges retain non-BMP code units and surrounding whitespace', () => {
  const text = ' A 😀中 ', value = input(), start = text.indexOf('😀'), end = start + '😀'.length;
  assert.equal(end - start, 2);
  value.gold.spans[0].start = start; value.gold.spans[0].end = end;
  value.gold.spans[0].mapping.ranges = [range(start, end)];
  value.observation.ranking.items = [hit('one-code-unit', [range(start, start + 1)])];
  assert.equal(scoreScientificEvidence(value).metrics.recallAt5.value, 0);
  value.observation.ranking.items.push(hit('other-code-unit', [range(start + 1, end)]));
  assert.equal(scoreScientificEvidence(value).metrics.recallAt5.value, 1);
});

test('MRR and recall cutoffs use the first complete prefix, including ranks 10/11/20/21', () => {
  for (const rank of [5, 6, 10, 11, 20, 21]) {
    const value = input();
    value.observation.ranking.items = Array.from({ length: rank }, (_, i) =>
      hit(`hit-${i}`, [range(0, 10, i + 1 === rank ? {} : { blockId: 'irrelevant' })]));
    const score = scoreScientificEvidence(value);
    for (const k of [5, 10, 20]) assert.equal(score.metrics[`recallAt${k}`].value, Number(rank <= k));
    assert.equal(score.metrics.mrrAt10.value, rank <= 10 ? 1 / rank : 0);
    assert.equal(score.completionRanks[0].firstRank, rank <= 20 ? rank : null);
  }
});

test('graded nDCG consumes all newly completed spans once and takes maximum gain per rank', () => {
  const value = input();
  value.gold.spans = [gold('low', 1), gold('high', 3), gold('middle', 2, [range(0, 10, { blockId: 'middle' })])];
  value.observation.ranking.items = [hit('shared'), hit('duplicate'), hit('middle', [range(0, 10, { blockId: 'middle' })])];
  const score = scoreScientificEvidence(value), ideal = 7 + 3 / Math.log2(3) + 1 / 2;
  assert.deepEqual(score.metrics.ndcgAt10.rankGains, [7, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
  almost(score.metrics.ndcgAt10.idealDcg, ideal);
  almost(score.metrics.ndcgAt10.value, (7 + 3 / 2) / ideal);
  assert.equal(score.metrics.recallAt5.value, 1);
});

test('independently confirmed absent mappings stay in recall and ideal denominators', () => {
  const value = input(), absent = gold('absent', 3);
  absent.mapping = { status: 'absent', reason: 'no-production-block', ranges: [] };
  value.gold.spans.push(absent);
  const score = scoreScientificEvidence(value);
  assert.equal(score.metrics.recallAt5.value, .5);
  assert.equal(score.metrics.recallAt5.denominator, 2);
  almost(score.metrics.ndcgAt10.value, 7 / (7 + 7 / Math.log2(3)));
  assert.deepEqual(score.mappingCounts, { mapped: 1, absent: 1, unresolved: 0 });
});

test('unresolved mappings and failed/unavailable channels stay NA with explicit counts', () => {
  const value = input();
  value.gold.spans[0].mapping = { status: 'unresolved', reason: 'gold-to-PDF-not-reviewed', ranges: [] };
  let score = scoreScientificEvidence(value);
  assert.equal(score.metrics.recallAt5.value, null);
  assert.equal(score.metrics.recallAt5.naReason, 'unresolved-gold-mapping');
  assert.equal(score.metrics.spanRecall.value, null);
  for (const status of ['failed', 'unavailable']) {
    const v = input();
    v.observation.ranking = { status, reason: 'receipt-missing', items: [] };
    score = scoreScientificEvidence(v);
    assert.equal(score.metrics.recallAt5.value, null);
    assert.equal(score.metrics.recallAt5.naReason, `${status}:receipt-missing`);
    assert.equal(score.metrics.spanRecall.value, 0);
    assert.equal(score.metrics.locatorAccuracy.value, null);
  }
  const v = input();
  v.observation.context = { status: 'unavailable', reason: 'reads-not-recorded', items: [] };
  score = scoreScientificEvidence(v);
  assert.equal(score.metrics.recallAt5.value, 1);
  assert.equal(score.metrics.spanRecall.value, null);
});

test('bad locator resolutions remain observed errors; unresolved resolutions invalidate coverage', () => {
  const value = input();
  value.observation.ranking.items.push({
    id: 'bad-hit', locators: [{ id: 'bad-locator', status: 'invalid', reason: 'stale-block', range: null }]
  });
  let score = scoreScientificEvidence(value);
  assert.equal(score.metrics.recallAt5.value, 1);
  assert.equal(score.metrics.rankingLocatorAccuracy.value, .5);
  assert.equal(score.metrics.locatorAccuracy.denominator, 2);
  value.observation.ranking.items[1].locators[0].status = 'unresolved';
  score = scoreScientificEvidence(value);
  assert.equal(score.metrics.recallAt5.value, null);
  assert.equal(score.metrics.rankingLocatorAccuracy.value, null);
  assert.equal(score.metrics.rankingLocatorAccuracy.unresolved, 1);
});

test('no positive gold is NA; observed returned hits do not invent unsupported answer judgments', () => {
  const value = input();
  value.gold.answerable = false; value.gold.category = 'unanswerable'; value.gold.spans = [];
  const score = scoreScientificEvidence(value);
  for (const key of ['recallAt5', 'mrrAt10', 'ndcgAt10', 'spanRecall']) {
    assert.equal(score.metrics[key].value, null); assert.equal(score.metrics[key].naReason, 'no-positive-gold');
  }
  assert.equal(score.unanswerable.returnedHits, 1);
  assert.equal(score.unanswerable.unsupportedPositiveAnswerEvidence, null);
  value.observation.unsupportedAnswerEvidence = { status: 'observed', unsupportedPositive: true };
  assert.equal(scoreScientificEvidence(value).unanswerable.unsupportedPositiveAnswerEvidence, true);
});

test('strict inputs reject duplicate gold/spans/items, missing receipts and success-shaped failures', () => {
  const mutations = [
    v => v.gold.spans.push(structuredClone(v.gold.spans[0])),
    v => v.gold.spans.push({ ...structuredClone(v.gold.spans[0]), id: 'another-id' }),
    v => v.observation.ranking.items.push(structuredClone(v.observation.ranking.items[0])),
    v => { delete v.observation.context; },
    v => { v.observation.ranking.status = 'failed'; v.observation.ranking.reason = 'failure'; },
    v => { v.gold.spans[0].mapping.ranges[0].end = 0; },
    v => { v.gold.spans[0].mapping.ranges[0].start = .5; },
    v => { v.gold.spans[0].mapping.ranges[0].extra = true; },
    v => { v.observation.queryId = 'another-query'; },
    v => { v.gold.answerable = false; }
  ];
  for (const mutate of mutations) {
    const value = input(); mutate(value);
    assert.throws(() => scoreScientificEvidence(value));
  }
});

test('cross-paper recall requires the second paper and cannot borrow the first paper ranges', () => {
  const value = input(), second = gold('second');
  second.paperId = 'second-paper'; second.sourceHash = hash('second-source');
  second.mapping.ranges = [range(0, 10, { paperId: second.paperId, sourceHash: second.sourceHash })];
  value.gold.category = 'cross-paper'; value.gold.spans.push(second);
  assert.equal(scoreScientificEvidence(value).metrics.recallAt5.value, .5);
  value.observation.context.items = [hit('first'), hit('second', second.mapping.ranges)];
  assert.equal(scoreScientificEvidence(value).metrics.spanRecall.value, 1);
});

test('macro summaries preserve invalid/unanswerable rows, categories and NA reasons', () => {
  const good = input(), failed = input(), negative = input();
  failed.gold.queryId = failed.observation.queryId = 'failed';
  failed.observation.ranking = { status: 'failed', reason: 'provider-failure', items: [] };
  negative.gold.queryId = negative.observation.queryId = 'negative';
  negative.gold.category = 'unanswerable'; negative.gold.answerable = false; negative.gold.spans = [];
  const summary = summarizeScientificEvidence([good, failed, negative]), recall = summary.overall.metrics.recallAt5;
  assert.equal(summary.overall.queries, 3);
  assert.deepEqual(recall, { value: 1, applicableQueries: 1, naQueries: 2,
    naReasons: { 'failed:provider-failure': 1, 'no-positive-gold': 1 } });
  assert.equal(summary.categories['paper-qa'].queries, 2);
  assert.equal(summary.categories.unanswerable.metrics.recallAt5.value, null);
  assert.equal(summary.scientificBaselineReady, false);
  assert.throws(() => summarizeScientificEvidence([good, good]), /duplicate_query/);
  assert.throws(() => summarizeScientificEvidence([]), /empty_cohort/);
  assert.deepEqual(summary, summarizeScientificEvidence([good, failed, negative]));
});

test('independent code-unit set oracle checks 100 varied interval unions and prefix ranks', () => {
  for (let seed = 0; seed < 100; seed++) {
    const value = input();
    value.observation.ranking.items = Array.from({ length: 12 }, (_, i) => {
      const start = (seed * 7 + i * 3) % 10, end = Math.min(10, start + 1 + (seed + i) % 5);
      return hit(`hit-${i}`, [range(start, end, (seed + i) % 7 === 0 ? { blockId: 'irrelevant' } : {})]);
    });
    const seen = new Set(); let first = null;
    value.observation.ranking.items.forEach((h, i) => {
      const r = h.locators[0].range;
      if (r.blockId === 'production-block') for (let x = r.start; x < r.end; x++) seen.add(x);
      if (seen.size === 10 && first === null) first = i + 1;
    });
    const score = scoreScientificEvidence(value);
    assert.equal(score.completionRanks[0].firstRank, first, `seed ${seed}`);
    for (const k of [5, 10, 20]) assert.equal(score.metrics[`recallAt${k}`].value, Number(first !== null && first <= k));
    assert.equal(score.metrics.mrrAt10.value, first !== null && first <= 10 ? 1 / first : 0);
  }
});
