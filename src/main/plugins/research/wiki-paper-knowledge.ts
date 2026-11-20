import type {PaperCardKnowledge} from '../../../shared/schemas/research-paper-card-knowledge';
import type {ScientificExtractionJob} from '../../../shared/schemas/research-scientific-extraction';
import type {WikiPaperKnowledgeSource} from '../../../shared/schemas/research-wiki-pages';
import {researchContentHash} from './research-files';

export type WikiPaperKnowledgeState = {
  state: 'current' | 'stale' | 'missing' | 'unavailable';
  generationId: string | null;
  digest: string | null;
};
export type WikiPaperKnowledgeProvider = {
  /** Synchronous owner/configuration fence. This does not stand in for original PDF byte verification. */
  state(projectId: string, documentId: string): WikiPaperKnowledgeState;
  /** Every consumer request verifies original bytes through the extraction owner. */
  read(projectId: string, source: WikiPaperKnowledgeSource, signal: AbortSignal): Promise<PaperCardKnowledge>;
};

/** Facts, entities and relations share one immutable, source-bound extraction publication. */
export function wikiPaperKnowledgeDigest(job: ScientificExtractionJob): string {
  if (job.status !== 'published' || job.resultHash === null) throw new Error('wiki_current_sources_required');
  return researchContentHash(JSON.stringify({
    version: 1, projectId: job.snapshot.projectId, paperIR: job.snapshot.source.paperIR,
    factGeneration: job.id, generation: job.generation,
    entityResolutionGeneration: job.snapshot.aliasesHash,
    relationGeneration: job.id, inputHash: job.inputHash, resultHash: job.resultHash
  }));
}
