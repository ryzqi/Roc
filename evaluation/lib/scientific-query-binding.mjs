import { z } from 'zod';
import { hash } from './common.mjs';
import { scientificQuerySchema } from './scientific-rag-corpus.mjs';
import { scientificEvidenceSourceSchema } from './scientific-evidence-resolution.mjs';
import { scientificEvidenceInputSchema, summarizeScientificEvidence } from './scientific-evidence-scoring.mjs';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const reason = z.string().min(1).refine(s => s.trim().length > 0);
const selection = z.discriminatedUnion('status', [
  z.strictObject({ queryId: id, queryHash: digest, status: z.literal('selected'),
    publishedQueryId: id, savedReceiptHash: digest }),
  z.strictObject({ queryId: id, queryHash: digest, status: z.literal('unavailable'), reason })
]);
export const scientificQueryBindingsSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('scientific-explicit-saved-query-bindings'),
  corpusInputDigest: digest, savedIndexHash: digest,
  contextReportHash: digest.nullable(), entries: z.array(selection).min(1)
});
export const scientificQueryBindingContract = Object.freeze({
  version: 1, status: 'Draft-agent-reviewed',
  selection: 'explicit-published-ID-and-receipt-digest;no-text-search-or-ID-inference',
  query: 'exact-production-boundary-trim-only;original-gold-query-and-review-digest-retained',
  scope: 'saved-single-paper-request-must-equal-single-gold-target',
  source: 'same-project-paper-sourceHash-and-current-source-observations',
  unsupported: 'every-gold-query-retained-with-unavailable-channels-and-NA-metrics',
  qualification: 'declarations-only-in-pure-functions;host-required;always-scientificBaselineReady=false'
});
const requireValue = (ok, code) => { if (!ok) throw new Error(`scientific_query_binding_${code}`); };
const unique = (values, code) => requireValue(new Set(values).size === values.length, code);
const unavailable = why => ({ status: 'unavailable', reason: why, items: [] });

export function validateScientificQuerySelections(bindings, queries, corpusInputDigest, savedIndexHash,
  contextReportHash) {
  bindings = scientificQueryBindingsSchema.parse(bindings);
  queries = queries.map(q => scientificQuerySchema.parse(q));
  unique(queries.map(q => q.id), 'duplicate_gold_query');
  unique(bindings.entries.map(e => e.queryId), 'duplicate_selection');
  unique(bindings.entries.filter(e => e.status === 'selected').map(e => e.publishedQueryId), 'reused_saved_query');
  requireValue(bindings.corpusInputDigest === corpusInputDigest && bindings.savedIndexHash === savedIndexHash
    && bindings.contextReportHash === contextReportHash, 'input_digest_changed');
  requireValue(hash(bindings.entries.map(e => [e.queryId, e.queryHash]))
    === hash(queries.map(q => [q.id, hash(q)])), 'gold_cohort_changed');
  return bindings;
}

/** Pure inputs declare already verified artifacts; only the host independently
 * reconstructs source/SQL observations and proves corpus qualification. */
export function bindScientificEvidenceQuery({ query, resolution, sources, papers, entry,
  receipt = null, observation = null }) {
  query = scientificQuerySchema.parse(query);
  entry = selection.parse(entry);
  sources = sources.map(s => scientificEvidenceSourceSchema.parse(s));
  const gold = scientificEvidenceInputSchema.shape.gold.parse(resolution.gold);
  requireValue(entry.queryId === query.id && entry.queryHash === hash(query)
    && resolution.queryHash === hash(query) && resolution.sourceObservationHash === hash(sources)
    && gold.queryId === query.id && gold.category === query.category && gold.answerable === query.answerable
    && hash(gold.spans) === hash(resolution.resolutions.map(r => r.span)), 'gold_resolution_changed');
  unique(query.targetPaperIds, 'duplicate_target');
  unique(sources.map(s => s.paperId), 'duplicate_source');
  unique(papers.map(p => p.paperId), 'duplicate_paper');
  requireValue(query.targetPaperIds.every(target => {
    const p = papers.find(p => p.paperId === target), s = sources.find(s => s.paperId === target);
    return p && s && p.sourceHash === s.sourceHash && s.projectId === gold.projectId;
  }), 'source_version_changed');
  let status = 'unbound', why = entry.status === 'unavailable' ? entry.reason : null;
  let originalObservationHash = null;
  if (entry.status === 'selected') {
    requireValue(receipt && receipt.questionId === entry.publishedQueryId
      && hash(receipt) === entry.savedReceiptHash, 'receipt_changed');
    requireValue(receipt.request?.query === query.query.trim()
      && receipt.request.query === receipt.publishedQuery.trim(), 'query_text_changed');
    requireValue(receipt.request.projectId === gold.projectId, 'request_project_changed');
    observation = scientificEvidenceInputSchema.shape.observation.parse(observation);
    requireValue(observation.queryId === receipt.questionId, 'observation_query_changed');
    originalObservationHash = hash(observation);
    if (query.targetPaperIds.length !== 1 || receipt.request.documentId !== query.targetPaperIds[0]) {
      why = 'saved-single-paper-request-cannot-satisfy-gold-target-scope';
    } else {
      status = 'bound';
      for (const item of [...observation.ranking.items, ...observation.context.items]) {
        for (const locator of item.locators.filter(l => l.status === 'verified')) {
          const r = locator.range, s = sources.find(s => s.paperId === r.paperId);
          requireValue(s?.status === 'parsed' && r.paperId === receipt.request.documentId
            && r.projectId === gold.projectId && r.sourceHash === s.sourceHash
            && hash({ parseId: r.parseId, parseHash: r.parseHash, parserFingerprint: r.parserFingerprint })
              === hash(s.parseRef), 'observation_source_changed');
        }
      }
    }
  } else requireValue(receipt === null && observation === null, 'unexpected_saved_observation');
  const input = scientificEvidenceInputSchema.parse({ schemaVersion: 1, gold, observation: status === 'bound'
    ? { ...observation, queryId: query.id }
    : { queryId: query.id, ranking: unavailable(why), context: unavailable(why),
      unsupportedAnswerEvidence: { status: 'unmeasured', unsupportedPositive: null } } });
  return { queryId: query.id, status, reason: why, entry, queryHash: hash(query),
    sourceObservationHash: hash(sources), resolutionHash: hash(resolution), originalObservationHash,
    input, scientificBaselineReady: false };
}

export function summarizeScientificQueryBindings(rows) {
  requireValue(Array.isArray(rows) && rows.length > 0, 'empty_cohort');
  unique(rows.map(r => r.queryId), 'duplicate_gold_query');
  return { schemaVersion: 1, kind: 'scientific-bound-saved-retrieval-score',
    status: 'calculated-draft-saved-observations', contract: scientificQueryBindingContract,
    counts: { queries: rows.length, bound: rows.filter(r => r.status === 'bound').length,
      unbound: rows.filter(r => r.status === 'unbound').length },
    bindings: rows.map(({ input, ...r }) => r),
    scores: summarizeScientificEvidence(rows.map(r => r.input)), scientificBaselineReady: false };
}
