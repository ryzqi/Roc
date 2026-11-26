import type {ScientificQueryResult} from '../../shared/schemas/research-scientific-query';
import type {ResearchKnowledgeSearchHit} from '../../shared/types';

/** Display projection only. Scientific identities are never sent to the legacy chunk-capture API. */
export function scientificQueryHits(result: ScientificQueryResult): ResearchKnowledgeSearchHit[] {
  return [...result.hits.map(hit => ({chunkId: hit.id, documentId: hit.documentId, title: hit.title,
    content: hit.content, locator: hit.sourceLocator?.rawLocator ?? null,
    sourceType: 'scientific', sourceId: hit.objectId, semantic: null,
    keywordRank: hit.signals.find(s => ['fts', 'lexical', 'exact'].includes(s.method))?.rank ?? null,
    vectorRank: hit.signals.find(s => s.method === 'dense')?.rank ?? null, rrfScore: hit.score})),
    ...result.legacy?.hits ?? []];
}
