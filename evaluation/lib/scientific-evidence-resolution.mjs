import { z } from 'zod';
import { hash } from './common.mjs';
import { scientificAnnotationSchema, scientificQuerySchema } from './scientific-rag-corpus.mjs';
import { scientificEvidenceInputSchema } from './scientific-evidence-scoring.mjs';

export const scientificEvidenceResolutionContract = Object.freeze({
  version: 1, status: 'Draft-agent-reviewed',
  match: 'unique-same-paper/source/page/kind-exact-full-block-text-and-normalized-bbox',
  offsets: 'original-UTF16-half-open;no-text-normalization-or-offset-search',
  capturedParse: 'exact-parseId-parseHash-parserFingerprint',
  absent: 'verified-parse-failure-or-unique-exact-object-with-no-indexed-text',
  unresolved: 'missing-source-stale-parse-ambiguous-or-nonexact-correspondence',
  scope: 'one-to-one-block-only;no-inferred-split/merge-or-human-review',
  qualification: 'no-runtime-context-or-scientific-baseline-qualification'
});

const range = scientificEvidenceInputSchema.shape.gold.shape.spans.element.shape.mapping.shape.ranges.element;
const id = range.shape.blockId, digest = range.shape.sourceHash;
const parseRef = z.strictObject({
  parseId: range.shape.parseId, parseHash: range.shape.parseHash,
  parserFingerprint: range.shape.parserFingerprint
});
const block = z.strictObject({
  id, blockId: id.nullable(), page: range.shape.page,
  kind: z.enum(['heading', 'text', 'table', 'figure', 'equation', 'caption', 'reference', 'algorithm', 'other']),
  bbox: z.tuple(Array.from({ length: 4 }, () => z.number().finite().min(0).max(1))),
  text: z.string(), indexedRanges: z.array(z.strictObject({ chunkId: id, range }))
}).refine(b => b.bbox[2] > b.bbox[0] && b.bbox[3] > b.bbox[1]);
export const scientificEvidenceSourceSchema = z.strictObject({
  projectId: id, paperId: id, sourceHash: digest,
  status: z.enum(['parsed', 'failed']), failureCode: z.string().min(1).nullable(),
  parseRef: parseRef.nullable(), blocks: z.array(block)
}).refine(s => s.status === 'parsed' ? s.parseRef !== null && s.failureCode === null
  : s.parseRef === null && s.failureCode !== null && s.blocks.length === 0);

const requireValue = (ok, code) => { if (!ok) throw new Error(`scientific_evidence_resolution_${code}`); };
const unique = (values, code) => requireValue(new Set(values).size === values.length, code);
const unavailable = reason => ({ status: 'unresolved', reason, ranges: [] });
const absent = reason => ({ status: 'absent', reason, ranges: [] });

/** Pure correspondence over independently verified source observations.
 * Only the host adapter proves PDF receipts/SQLite bytes or corpus readiness.
 * This function never turns a declared source status into that proof. */
export function resolveScientificEvidenceGold(query, annotations, observations, projectId) {
  query = scientificQuerySchema.parse(query);
  annotations = annotations.map(a => scientificAnnotationSchema.parse(a));
  observations = observations.map(s => scientificEvidenceSourceSchema.parse(s));
  unique(annotations.map(a => a.paperId), 'duplicate_annotation');
  unique(observations.map(s => s.paperId), 'duplicate_source');
  unique(query.expectedEvidenceSpans.map(s => s.id), 'duplicate_gold_span');
  requireValue((query.answerable ? query.expectedEvidenceSpans.length > 0
    : query.schemaVersion === 2 || query.expectedEvidenceSpans.length === 0)
    && (query.category === 'unanswerable') === !query.answerable, 'answerability_mismatch');
  if (query.schemaVersion === 2) {
    requireValue((query.answerability === 'answerable') === query.answerable, 'answerability_mismatch');
    if (!query.answerable) requireValue(query.expectedEvidenceSpans.every(span =>
      query.requiredConditions.some(condition => condition.status === 'known'
        && condition.paperId === span.paperId && condition.evidenceSpanIds.includes(span.id))),
    'unanswerable_condition_evidence_missing');
  }
  const goldById = new Map(annotations.map(a => [a.paperId, a]));
  const sourceById = new Map(observations.map(s => [s.paperId, s]));
  for (const annotation of annotations) unique(annotation.blocks.map(b => b.blockId), 'duplicate_gold_block');
  for (const source of observations) {
    requireValue(source.projectId === projectId, 'project_mismatch');
    unique(source.blocks.map(b => b.id), 'duplicate_prediction');
    requireValue(source.blocks.every(b => b.blockId === null || b.blockId === b.id), 'block_identity_mismatch');
    unique(source.blocks.flatMap(b => b.indexedRanges.map(r => r.chunkId)), 'duplicate_chunk');
    for (const b of source.blocks) for (const { range: r } of b.indexedRanges) {
      requireValue(b.blockId !== null && r.blockId === b.blockId && r.page === b.page
        && r.paperId === source.paperId && r.projectId === source.projectId
        && r.sourceHash === source.sourceHash && r.end <= b.text.length
        && hash({ parseId: r.parseId, parseHash: r.parseHash, parserFingerprint: r.parserFingerprint })
          === hash(source.parseRef), 'index_identity_mismatch');
    }
  }
  const allResolutions = query.expectedEvidenceSpans.map(span => {
    const annotation = goldById.get(span.paperId), source = sourceById.get(span.paperId);
    const expected = annotation?.blocks.find(b => b.blockId === span.blockId);
    requireValue(annotation?.sourceHash === span.sourceHash && expected
      && expected.page === span.page && span.end > span.start && span.end <= expected.text.length
      && expected.text.slice(span.start, span.end) === span.quote
      && query.targetPaperIds.includes(span.paperId)
      && query.targetBlockIds.includes(span.blockId), 'gold_quote_or_target_changed');
    let mapping, matchedId = null;
    if (!source) mapping = unavailable('production-source-unavailable');
    else if (source.sourceHash !== span.sourceHash) mapping = unavailable('production-source-version-mismatch');
    else if (annotation.parseRef && hash(annotation.parseRef) !== hash(source.parseRef)) {
      mapping = unavailable('captured-parse-mismatch');
    } else if (source.status === 'failed') mapping = absent(`production-parse-failed:${source.failureCode}`);
    else {
      const candidates = source.blocks.filter(b => b.page === span.page && b.kind === expected.kind
        && b.text === expected.text && hash(b.bbox) === hash(expected.bbox)
        && (!annotation.parseRef || b.blockId === expected.blockId));
      if (candidates.length !== 1) mapping = unavailable(candidates.length
        ? 'ambiguous-exact-block-correspondence' : 'no-exact-block-correspondence');
      else {
        const b = candidates[0]; matchedId = b.id;
        // The full expected span must exist in the index, not just a substring
        // of one child. Preserve a known missing object as absent.
        const intervals = b.indexedRanges.map(i => i.range).sort((a, c) => a.start - c.start || a.end - c.end);
        let coveredEnd = span.start;
        for (const r of intervals) {
          if (r.start > coveredEnd) break;
          coveredEnd = Math.max(coveredEnd, r.end);
        }
        mapping = coveredEnd < span.end ? absent('exact-object-not-fully-indexed')
          : { status: 'mapped', reason: null, ranges: [{
            projectId, paperId: source.paperId, sourceHash: source.sourceHash, ...source.parseRef,
            blockId: b.blockId, page: b.page, start: span.start, end: span.end
          }] };
      }
    }
    const { quote, ...identity } = span;
    return { span: { ...identity, parseRef: annotation.parseRef, mapping },
      originalQuoteHash: hash(quote), originalBlockHash: hash(expected), matchedId };
  });
  // Refusal-condition evidence remains auditable, but is not positive retrieval
  // gold. The existing scorer deliberately excludes unanswerable questions.
  const resolutions = query.answerable ? allResolutions : [];
  const gold = scientificEvidenceInputSchema.shape.gold.parse({
    queryId: query.id, projectId, category: query.category,
    answerable: query.answerable, spans: resolutions.map(r => r.span)
  });
  return { schemaVersion: 1, status: 'resolved-draft-correspondence', contract: scientificEvidenceResolutionContract,
    queryHash: hash(query), annotationHashes: Object.fromEntries(annotations.map(a => [a.paperId, hash(a)])),
    sourceObservationHash: hash(observations), gold, resolutions,
    ...(query.schemaVersion === 2 ? { conditionResolutions: query.answerable ? [] : allResolutions } : {}),
    scientificBaselineReady: false };
}
