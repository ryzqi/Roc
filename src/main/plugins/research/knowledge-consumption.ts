import type {ResearchKnowledgeSearchResult} from '../../../shared/types';

/** Tool content is bounded; the unabridged ranking receipt belongs in ToolMessage.artifact. */
export function knowledgeSearchView(result: ResearchKnowledgeSearchResult, maxChars = 2000) {
  const versions = new Map(result.ranking.candidates.map(candidate => [candidate.chunkId, candidate.indexedVersion]));
  return {
    query: result.query, generatedAt: result.generatedAt,
    coverage: result.ranking.coverage, degradation: result.ranking.degradation ?? null,
    route: result.ranking.route, reranker: result.ranking.reranker.status,
    hits: result.hits.map(hit => {
      const indexedVersion = versions.get(hit.chunkId);
      if (!indexedVersion) throw new Error('research_knowledge_snapshot_missing_hit');
      return {
      chunkId: hit.chunkId, documentId: hit.documentId, title: hit.title,
      content: hit.content.slice(0, maxChars), contentChars: hit.content.length,
      locator: hit.locator, sourceType: hit.sourceType, sourceId: hit.sourceId,
      indexedVersion, score: hit.rrfScore
    };})
  };
}
