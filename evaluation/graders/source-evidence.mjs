import { fail } from '../lib/common.mjs';

function compatible(span, evidence) {
  return span.sourceId === evidence.sourceId && span.sourceVersion === evidence.sourceVersion
    && span.sourceSha256 === evidence.sourceSha256 && span.parserVersion === evidence.parserVersion;
}
export function evidenceCoverage(spans, evidence) {
  let cursor = evidence.locator.startOffset;
  const ranges = spans.filter(s => compatible(s, evidence)).sort((a, b) => a.startOffset - b.startOffset);
  for (const range of ranges) {
    if (range.startOffset > cursor) break;
    if (range.endOffset > cursor) cursor = range.endOffset;
    if (cursor >= evidence.locator.endOffset) return true;
  }
  return false;
}
export function coverageMetrics(spans, expected) {
  if (!expected || !Array.isArray(expected.evidence) || !Array.isArray(expected.evidenceChains)) fail('scoring', 'rag_hidden_truth_unreadable');
  const covered = new Set(expected.evidence.filter(e => evidenceCoverage(spans, e)).map(e => e.id));
  return { covered, recall: expected.evidence.length ? covered.size / expected.evidence.length : null,
    chainRecall: expected.evidenceChains.length ? expected.evidenceChains.filter(chain => chain.every(id => covered.has(id))).length / expected.evidenceChains.length : null };
}
export function rankingMetrics(ids, state, expected) {
  const byId = new Map(state.chunks.map(c => [c.chunkId, c])), spans = ids.map(id => {
    const chunk = byId.get(id); if (!chunk) fail('scoring', 'rag_unmapped_retrieval_hit'); return chunk;
  });
  const top20 = coverageMetrics(spans.slice(0, 20), expected);
  const seen = new Set(); let dcg = 0;
  // Each source evidence gains credit once, at the first rank that completely
  // exposes its span. Multiple annotations exposed by one hit use max relevance.
  for (let i = 0; i < Math.min(10, spans.length); i++) {
    const newly = expected.evidence.filter(e => !seen.has(e.id) && evidenceCoverage(spans.slice(0, i + 1), e));
    newly.forEach(e => seen.add(e.id));
    const relevance = Math.max(0, ...newly.map(e => e.relevance));
    dcg += (2 ** relevance - 1) / Math.log2(i + 2);
  }
  const ideal = expected.evidence.map(e => e.relevance).sort((a, b) => b - a).slice(0, 10)
    .reduce((sum, relevance, i) => sum + (2 ** relevance - 1) / Math.log2(i + 2), 0);
  return { recall20: top20.recall, ndcg10: ideal ? dcg / ideal : null, evidenceChainRecall20: top20.chainRecall };
}
