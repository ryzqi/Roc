import { z } from 'zod';
import { hash } from './common.mjs';

// Arithmetic only. The caller must independently resolve original gold and
// actual retrieved/read content to these ranges before invoking this module.
// No status, digest or syntactically valid range proves that resolution.
export const scientificEvidenceScoringContract = Object.freeze({
  version: 1, status: 'Draft-agent-reviewed',
  input: 'independently-resolved-production-block-UTF16-half-open-ranges',
  identity: 'project-paper-sourceHash-parseId-parseHash-parserFingerprint-block-page',
  recall: 'all-required-ranges-covered-by-compatible-prefix-interval-unions',
  mrr: 'first-prefix-completing-any-gold-span-at-rank<=10',
  ndcg: 'maximum-newly-completed-relevance-per-rank-gain=2^r-1-discount=log2(rank+1)',
  ideal: 'all-unique-gold-spans-sorted-by-relevance-including-absent-mappings',
  context: 'actual-read-or-assembled-content-only-independent-of-ranking',
  locator: 'independent-exact-resolution-valid/observed-unresolved-is-NA',
  qualification: 'calculator-only-always-scientificBaselineReady=false'
});

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const reason = z.string().min(1).refine(s => s.trim().length > 0);
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const parseRef = z.strictObject({ parseId: id, parseHash: digest, parserFingerprint: digest });
const range = z.strictObject({
  projectId: id, paperId: id, sourceHash: digest, ...parseRef.shape,
  blockId: id, page: z.number().int().positive(), start: offset, end: offset
}).refine(s => s.end > s.start, 'nonempty half-open interval required');
const mapping = z.strictObject({
  status: z.enum(['mapped', 'absent', 'unresolved']), reason: reason.nullable(),
  ranges: z.array(range).max(2000)
}).refine(s => s.status === 'mapped'
  ? s.reason === null && s.ranges.length > 0 : s.reason !== null && s.ranges.length === 0);
const goldSpan = z.strictObject({
  id, paperId: id, sourceHash: digest, blockId: id, page: z.number().int().positive(),
  start: offset, end: offset, relevance: z.number().int().min(1).max(3),
  parseRef: parseRef.nullable(), mapping
}).refine(s => s.end > s.start);
const locator = z.strictObject({
  id, status: z.enum(['verified', 'invalid', 'unresolved']),
  reason: reason.nullable(), range: range.nullable()
}).refine(s => s.status === 'verified'
  ? s.reason === null && s.range !== null : s.reason !== null && s.range === null);
const item = z.strictObject({ id, locators: z.array(locator).min(1).max(2000) });
const channel = z.strictObject({
  status: z.enum(['verified', 'failed', 'unavailable']), reason: reason.nullable(),
  items: z.array(item).max(10000)
}).refine(s => s.status === 'verified'
  ? s.reason === null : s.reason !== null && s.items.length === 0);

export const scientificEvidenceInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  gold: z.strictObject({
    queryId: id, projectId: id,
    category: z.enum(['paper-qa', 'method-equation', 'table-results', 'cross-paper', 'figure', 'unanswerable']),
    answerable: z.boolean(), spans: z.array(goldSpan).max(2000)
  }),
  observation: z.strictObject({
    queryId: id, ranking: channel, context: channel,
    // Positive retrieval alone is not an unsupported answer. Such judgments
    // require independent answer evidence and are optional, explicitly NA.
    unsupportedAnswerEvidence: z.strictObject({
      status: z.enum(['observed', 'unmeasured']), unsupportedPositive: z.boolean().nullable()
    }).refine(s => (s.status === 'observed') === (s.unsupportedPositive !== null))
  })
});

const requireValue = (ok, code) => { if (!ok) throw new Error(`scientific_evidence_${code}`); };
const unique = (values, code) => requireValue(new Set(values).size === values.length, code);
const identity = ({ start, end, ...target }) => hash(target);
const parseIdentity = ({ parseId, parseHash, parserFingerprint }) => ({ parseId, parseHash, parserFingerprint });

function validate(input) {
  const { gold, observation } = scientificEvidenceInputSchema.parse(input);
  requireValue(gold.queryId === observation.queryId, 'query_mismatch');
  requireValue(gold.answerable === (gold.spans.length > 0)
    && (gold.category === 'unanswerable') === !gold.answerable, 'answerability_mismatch');
  unique(gold.spans.map(s => s.id), 'duplicate_gold_id');
  unique(gold.spans.map(({ id: ignored, relevance: ignoredRelevance, mapping: ignoredMapping, ...s }) =>
    hash(s)), 'duplicate_gold_span');
  for (const s of gold.spans) {
    for (const r of s.mapping.ranges) {
      requireValue(r.projectId === gold.projectId && r.paperId === s.paperId
        && r.sourceHash === s.sourceHash && r.page === s.page
        && (!s.parseRef || hash(parseIdentity(r)) === hash(s.parseRef)), 'gold_mapping_identity_mismatch');
    }
    unique(s.mapping.ranges.map(hash), 'duplicate_required_range');
    requireValue(new Set(s.mapping.ranges.map(r => hash(parseIdentity(r)))).size <= 1,
      'gold_mapping_mixed_parses');
  }
  for (const c of [observation.ranking, observation.context]) {
    unique(c.items.map(i => i.id), 'duplicate_item');
    unique(c.items.flatMap(i => i.locators.map(l => l.id)), 'duplicate_locator_occurrence');
  }
  return { gold, observation };
}

/** Adjacent intervals may join; gaps, stale identities and duplicate coverage
 * never fill a missing code unit. Offset units are UTF-16, never codepoints. */
function unionCovers(required, ranges) {
  const compatible = ranges.filter(r => identity(r) === identity(required))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let end = required.start;
  for (const r of compatible) {
    if (r.start > end) break;
    end = Math.max(end, r.end);
    if (end >= required.end) return true;
  }
  return false;
}
const metric = (value, denominator, naReason = null) => ({ value, denominator, naReason });
const rangesOf = items => items.flatMap(i => i.locators.filter(l => l.status === 'verified').map(l => l.range));
const channelReason = c => c.status !== 'verified' ? `${c.status}:${c.reason}`
  : c.items.some(i => i.locators.some(l => l.status === 'unresolved')) ? 'unresolved-source-locator' : null;
const covered = (s, ranges) => s.mapping.status === 'mapped'
  && s.mapping.ranges.every(r => unionCovers(r, ranges));

function locatorAccuracy(c) {
  const locators = c.items.flatMap(i => i.locators), invalid = locators.filter(l => l.status === 'invalid').length;
  const unresolved = locators.filter(l => l.status === 'unresolved').length;
  const failure = channelReason(c);
  return { ...metric(failure || !locators.length ? null : (locators.length - invalid) / locators.length,
    locators.length, failure ?? (!locators.length ? 'no-observed-locators' : null)), invalid, unresolved };
}

export function scoreScientificEvidence(input) {
  const { gold, observation } = validate(input), { ranking, context } = observation;
  const mappingReason = gold.spans.some(s => s.mapping.status === 'unresolved') ? 'unresolved-gold-mapping' : null;
  const rankingReason = !gold.answerable ? 'no-positive-gold' : mappingReason ?? channelReason(ranking);
  const contextReason = !gold.answerable ? 'no-positive-gold' : mappingReason ?? channelReason(context);
  const completionRanks = gold.spans.map(s => {
    if (rankingReason) return { id: s.id, firstRank: null };
    const index = ranking.items.slice(0, 20).findIndex((_, i) =>
      covered(s, rangesOf(ranking.items.slice(0, i + 1))));
    return { id: s.id, firstRank: index < 0 ? null : index + 1 };
  });
  const contextRanges = rangesOf(context.items);
  const contextCoveredIds = contextReason ? null : gold.spans.filter(s => covered(s, contextRanges)).map(s => s.id);
  const metrics = Object.fromEntries([5, 10, 20].map(k => [`recallAt${k}`, metric(rankingReason ? null
    : completionRanks.filter(s => s.firstRank !== null && s.firstRank <= k).length / gold.spans.length,
  gold.spans.length, rankingReason)]));
  const first = completionRanks.filter(s => s.firstRank !== null && s.firstRank <= 10).map(s => s.firstRank);
  metrics.mrrAt10 = metric(rankingReason ? null : first.length ? 1 / Math.min(...first) : 0,
    gold.answerable ? 1 : 0, rankingReason);
  const gains = Array.from({ length: 10 }, (_, i) => {
    const newlyCovered = gold.spans.filter((_, j) => completionRanks[j].firstRank === i + 1);
    return newlyCovered.length ? 2 ** Math.max(...newlyCovered.map(s => s.relevance)) - 1 : 0;
  });
  const dcg = gains.reduce((n, gain, i) => n + gain / Math.log2(i + 2), 0);
  const ideal = gold.spans.map(s => s.relevance).sort((a, b) => b - a).slice(0, 10)
    .reduce((n, relevance, i) => n + (2 ** relevance - 1) / Math.log2(i + 2), 0);
  metrics.ndcgAt10 = { ...metric(rankingReason ? null : dcg / ideal, gold.spans.length, rankingReason),
    dcg: rankingReason ? null : dcg, idealDcg: gold.answerable ? ideal : null,
    rankGains: rankingReason ? null : gains };
  metrics.spanRecall = metric(contextReason ? null : contextCoveredIds.length / gold.spans.length,
    gold.spans.length, contextReason);
  metrics.rankingLocatorAccuracy = locatorAccuracy(ranking);
  metrics.contextLocatorAccuracy = locatorAccuracy(context);
  const combinedReason = channelReason(ranking) ?? channelReason(context);
  const all = [ranking, context].flatMap(c => c.items.flatMap(i => i.locators));
  metrics.locatorAccuracy = { ...metric(combinedReason || !all.length ? null
    : all.filter(l => l.status === 'verified').length / all.length, all.length,
  combinedReason ?? (!all.length ? 'no-observed-locators' : null)),
  invalid: all.filter(l => l.status === 'invalid').length, unresolved: all.filter(l => l.status === 'unresolved').length };
  return {
    schemaVersion: 1, kind: 'scientific-mapped-evidence-calculation', status: 'calculated-unqualified',
    queryId: gold.queryId, category: gold.category, answerable: gold.answerable,
    contract: scientificEvidenceScoringContract, inputHash: hash(input),
    mappingCounts: Object.fromEntries(['mapped', 'absent', 'unresolved']
      .map(status => [status, gold.spans.filter(s => s.mapping.status === status).length])),
    rankingStatus: ranking.status, contextStatus: context.status, metrics, completionRanks, contextCoveredIds,
    unanswerable: gold.answerable ? null : {
      returnedHits: ranking.status === 'verified' ? ranking.items.length : null,
      readItems: context.status === 'verified' ? context.items.length : null,
      unsupportedPositiveAnswerEvidence: observation.unsupportedAnswerEvidence.unsupportedPositive,
      judgmentStatus: observation.unsupportedAnswerEvidence.status
    },
    scientificBaselineReady: false
  };
}

/** Macro means with explicit applicable/NA counts. Every preselected query
 * must be supplied; this helper cannot verify cohort completeness. */
export function summarizeScientificEvidence(inputs) {
  requireValue(Array.isArray(inputs) && inputs.length > 0, 'empty_cohort');
  const rows = inputs.map(scoreScientificEvidence);
  unique(rows.map(r => r.queryId), 'duplicate_query');
  const summarize = selected => ({
    queries: selected.length,
    answerableQueries: selected.filter(r => r.answerable).length,
    metrics: Object.fromEntries(Object.keys(rows[0].metrics).map(key => {
      const applicable = selected.filter(r => r.metrics[key].value !== null);
      const naReasons = {};
      for (const r of selected.filter(r => r.metrics[key].value === null)) {
        const reason = r.metrics[key].naReason;
        naReasons[reason] = (naReasons[reason] ?? 0) + 1;
      }
      return [key, { value: applicable.length
        ? applicable.reduce((n, r) => n + r.metrics[key].value, 0) / applicable.length : null,
      applicableQueries: applicable.length, naQueries: selected.length - applicable.length, naReasons }];
    }))
  });
  return { schemaVersion: 1, kind: 'scientific-mapped-evidence-summary', status: 'calculated-unqualified',
    contract: scientificEvidenceScoringContract, inputHash: hash(inputs), overall: summarize(rows),
    categories: Object.fromEntries([...new Set(rows.map(r => r.category))].sort()
      .map(category => [category, summarize(rows.filter(r => r.category === category))])),
    rows, scientificBaselineReady: false };
}
