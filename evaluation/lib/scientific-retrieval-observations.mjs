import { hash, sha256 } from './common.mjs';
import { scientificEvidenceInputSchema } from './scientific-evidence-scoring.mjs';
import { scientificEvidenceSourceSchema } from './scientific-evidence-resolution.mjs';

export const scientificContextReadPolicy = Object.freeze({
  version: 1, selection: 'first-three-saved-ranked-hits',
  maxReads: 3, maxCharsPerRead: 2000, neighbors: true,
  queryMaxChars: 6000, scope: 'new-readonly-production-context-reads;not-historical-context-or-agent-selection'
});
const requireValue = (ok, code) => { if (!ok) throw new Error(`scientific_retrieval_observation_${code}`); };
const unique = (values, code) => requireValue(new Set(values).size === values.length, code);
const channel = (status, reason = null, items = []) => ({ status, reason, items });

/** Independent substring/identity verification over host-verified PDF blocks,
 * index intervals and raw SQL parent positions. Pure inputs are declarations,
 * not proof that those host observations or actual reads occurred. */
export function scientificRetrievalSourceIndex(state, observations) {
  const byChunk = new Map(state.chunks.map(c => [c.chunkId, c])), ranges = new Map();
  unique(state.chunks.map(c => c.chunkId), 'duplicate_chunk');
  for (const raw of observations) {
    const source = scientificEvidenceSourceSchema.parse(raw);
    for (const block of source.blocks) for (const entry of block.indexedRanges) {
      const c = byChunk.get(entry.chunkId), r = entry.range;
      requireValue(!ranges.has(entry.chunkId) && c && c.blockId === block.blockId && block.id === c.blockId
        && r.blockId === c.blockId && r.page === block.page && r.projectId === c.projectId
        && r.projectId === source.projectId
        && r.paperId === source.paperId && c.paperId === source.paperId && c.documentId === source.paperId
        && r.sourceHash === source.sourceHash && c.sourceSha256 === source.sourceHash
        && r.parseId === c.parseId && hash({ parseId: r.parseId, parseHash: r.parseHash,
          parserFingerprint: r.parserFingerprint }) === hash(source.parseRef)
        && r.start === c.startOffset && r.end === c.endOffset && r.end <= block.text.length
        && r.end - r.start === c.contentChars && sha256(block.text.slice(r.start, r.end)) === c.chunkHash,
      'source_index_changed');
      ranges.set(entry.chunkId, { range: r, block, chunk: c });
    }
  }
  requireValue(ranges.size === byChunk.size, 'source_chunk_missing');
  return { byChunk, ranges };
}

export function scientificContextRequests(receipt, state) {
  if (receipt.failure !== null) return [];
  const byId = new Map(state.chunks.map(c => [c.chunkId, c]));
  return receipt.result.hits.slice(0, scientificContextReadPolicy.maxReads).map(hit => {
    const c = byId.get(hit.chunkId);
    requireValue(c?.retrieved && c.projectId === receipt.request.projectId
      && c.documentId === receipt.request.documentId, 'request_scope_changed');
    return { projectId: receipt.request.projectId, chunkId: c.chunkId, expectedIndexedVersion: c.indexedVersion,
      maxChars: scientificContextReadPolicy.maxCharsPerRead, neighbors: scientificContextReadPolicy.neighbors };
  });
}

function occurrence(id, range, locator, expectedLocator) {
  return { id, locators: [{ id: `${id}-locator`,
    status: locator === expectedLocator ? 'verified' : 'invalid',
    reason: locator === expectedLocator ? null : 'returned-page-locator-mismatch',
    range: locator === expectedLocator ? range : null }] };
}

function contextWindow(mapped, origin, budget) {
  const text = origin.block.text;
  let start = Math.max(0, Math.min(mapped.range.start - Math.floor(budget / 4), text.length - budget));
  // UTF-16 windows must not split a supplementary Unicode character.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start++;
  let end = Math.min(start + budget, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  return { start, end };
}

/** Verify a NEW production read. Neighbor membership comes from independent
 * raw SQLite rows; ranges are original block-relative UTF-16, not hit offsets. */
export function verifyScientificContextRead(read, sourceIndex, sqlParents, request) {
  requireValue(hash(read.request) === hash(request)
    && Number.isInteger(request.maxChars) && request.maxChars >= 200 && request.maxChars <= 8000
    && typeof request.neighbors === 'boolean'
    && Number.isFinite(read.elapsedMs) && read.elapsedMs >= 0
    && typeof read.startedAt === 'string' && Number.isFinite(Date.parse(read.startedAt))
    && typeof read.completedAt === 'string' && Date.parse(read.completedAt) >= Date.parse(read.startedAt),
  'context_receipt_changed');
  if (read.failure !== null) {
    requireValue(typeof read.failure?.code === 'string' && read.failure.code.length > 0
      && read.result === null && read.resultHash === null, 'context_failure_invalid');
    return { status: 'failed', reason: `context-read-failed:${read.failure.code}`, items: [] };
  }
  const result = read.result, selected = sourceIndex.ranges.get(request.chunkId);
  const parent = sourceIndex.ranges.get(selected?.chunk.parentChunkId);
  const position = sqlParents.find(p => p.id === parent?.chunk.chunkId);
  requireValue(selected && parent && position && parent.chunk.parentChunkId === parent.chunk.chunkId
    && selected.chunk.indexedVersion === request.expectedIndexedVersion
    && selected.range.projectId === request.projectId && parent.range.projectId === request.projectId
    && hash(result) === read.resultHash && result?.derived === false && Array.isArray(result.neighbors)
    && result.context?.chunkId === request.chunkId, 'context_identity_changed');
  const adjacent = request.neighbors ? sqlParents.filter(p => p.documentId === position.documentId
    && p.id !== position.id && Math.abs(p.index - position.index) === 1)
    .sort((a, b) => a.index - b.index).map(p => p.id) : [];
  requireValue(hash(result.neighbors.map(n => n.chunkId)) === hash(adjacent), 'context_neighbors_changed');
  const mainWindow = contextWindow(selected, parent,
    request.neighbors ? Math.floor(request.maxChars * 0.6) : request.maxChars);
  const neighborBudget = Math.floor((request.maxChars - (mainWindow.end - mainWindow.start))
    / Math.max(1, adjacent.length));
  const items = [result.context, ...result.neighbors].map((item, i) => {
    const actual = sourceIndex.ranges.get(item.chunkId), origin = sourceIndex.ranges.get(item.parentChunkId);
    requireValue(actual && origin && actual.chunk.parentChunkId === origin.chunk.chunkId
      && origin.chunk.parentChunkId === origin.chunk.chunkId
      && origin.range.paperId === selected.range.paperId && origin.range.projectId === request.projectId
      && (i !== 0 || origin.chunk.chunkId === parent.chunk.chunkId)
      && Number.isInteger(item.start) && Number.isInteger(item.end)
      && item.start >= 0 && item.end > item.start && item.end <= origin.block.text.length
      && item.totalChars === origin.block.text.length && item.indexedVersion === origin.chunk.indexedVersion
      && item.locator === origin.chunk.locator
      && item.content === origin.block.text.slice(item.start, item.end)
      && item.content.length === item.end - item.start, 'context_source_changed');
    const window = i === 0 ? mainWindow : contextWindow(actual, origin, neighborBudget);
    requireValue(item.start === window.start && item.end === window.end, 'context_window_changed');
    return occurrence(`context-${i}`, { ...origin.range, start: item.start, end: item.end },
      item.locator, `page ${origin.range.page}`);
  });
  requireValue([result.context, ...result.neighbors].reduce((n, i) => n + i.content.length, 0)
    <= request.maxChars, 'context_budget_changed');
  return { status: 'verified', reason: null, items };
}

/** Adapt verified saved ranking and separately captured reads. No gold or
 * query aliases: the observation queryId remains the original published ID. */
export function observeScientificRetrievalEvidence(receipt, sourceIndex, sqlParents, reads = null) {
  requireValue(typeof receipt.questionId === 'string' && receipt.questionId.length > 0
    && receipt.request.query === receipt.publishedQuery.trim()
    && Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0, 'query_changed');
  let ranking, context;
  if (receipt.failure !== null) {
    requireValue(typeof receipt.failure?.code === 'string' && receipt.failure.code.length > 0
      && receipt.result === null && receipt.resultHash === null
      && (reads === null || reads.length === 0), 'ranking_failure_invalid');
    ranking = channel('failed', `search-failed:${receipt.failure.code}`);
    context = channel('unavailable', 'no-context-read-after-failed-search');
  } else {
    requireValue(receipt.result?.query === receipt.request.query
      && hash(receipt.result) === receipt.resultHash, 'ranking_result_changed');
    unique(receipt.result.hits.map(h => h.chunkId), 'duplicate_hit');
    ranking = channel('verified', null, receipt.result.hits.map((hit, i) => {
      const mapped = sourceIndex.ranges.get(hit.chunkId), c = mapped?.chunk;
      const candidate = receipt.result.ranking.candidates.find(r => r.chunkId === hit.chunkId);
      requireValue(c?.retrieved && c.documentId === receipt.request.documentId
        && c.projectId === receipt.request.projectId && c.documentId === hit.documentId
        && c.sourceId === hit.sourceId && c.locator === hit.locator && sha256(hit.content) === c.chunkHash
        && candidate?.indexedVersion === c.indexedVersion && candidate.outputRank === i + 1
        && hit.semantic?.blockId === c.blockId && hit.semantic?.parseId === c.parseId
        && hit.semantic?.sourceHash === c.sourceSha256 && hit.semantic?.paperId === c.paperId,
      'ranking_source_changed');
      const expected = c.chunkId === c.parentChunkId ? `page ${mapped.range.page}`
        : `page ${mapped.range.page}; UTF-16 ${mapped.range.start + 1}-${mapped.range.end}`;
      return occurrence(`ranking-${i}`, mapped.range, hit.locator, expected);
    }));
    if (reads === null) context = channel('unavailable', 'historical-context-not-recorded');
    else {
      const requests = scientificContextRequests(receipt, { chunks: [...sourceIndex.byChunk.values()] });
      requireValue(reads.length === requests.length, 'context_read_count_changed');
      const verified = reads.map((r, i) => verifyScientificContextRead(r, sourceIndex, sqlParents, requests[i]));
      const failed = verified.find(r => r.status === 'failed');
      context = failed ? channel('failed', failed.reason) : channel('verified', null,
        verified.flatMap((r, i) => r.items.map((item, j) => ({
          ...item, id: `context-${i}-${j}`, locators: item.locators.map(l => ({ ...l, id: `context-${i}-${j}-locator` }))
        }))));
    }
  }
  return scientificEvidenceInputSchema.shape.observation.parse({
    queryId: receipt.questionId, ranking, context,
    unsupportedAnswerEvidence: { status: 'unmeasured', unsupportedPositive: null }
  });
}
