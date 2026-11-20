import type {PaperIRV2, PaperIRArtifact} from '../../../shared/schemas/research-paper-ir-v2';
import type {ResearchRepository} from './repository';
import type {ResearchEmbeddingService, PreparedKnowledgeEmbeddings} from './embedding-service';
import type {KnowledgeSourceWrite} from './knowledge-repository';
import type {ScientificGeneration, ScientificIndexSnapshot, ScientificEmbeddingIdentity} from './scientific-index-repository';

export type StagedScientificIndex = {generation: ScientificGeneration | null; generic: PreparedKnowledgeEmbeddings};

/** All provider work finishes before the source owner replaces any live generic rows. */
export class ScientificIndexBuilder {
  constructor(private readonly repository: ResearchRepository, private readonly embeddings: ResearchEmbeddingService) {}

  async stage(input: {ir: PaperIRV2 | null; paperIR: PaperIRArtifact | null; source: ScientificIndexSnapshot['source'];
    generic: KnowledgeSourceWrite; metadata: Record<string, unknown>; embedding: ScientificEmbeddingIdentity | null;
    signal: AbortSignal}): Promise<StagedScientificIndex> {
    const generation = input.ir === null ? null : this.repository.scientificIndex.begin({
      ir: input.ir, projectId: input.generic.projectId, source: input.source, embedding: input.embedding,
      ...(input.paperIR ? {paperIR: input.paperIR} : {})});
    try {
      if (generation && input.embedding) {
        const chunks = this.repository.scientificIndex.chunks(generation.id, input.generic.projectId).filter(chunk => chunk.retrieval);
        const vectors = await this.embeddings.embedInputs(chunks.map(chunk => ({text: chunk.embeddingText, version: chunk.inputVersion})),
          input.embedding, input.signal);
        this.repository.scientificIndex.writeEmbeddings(generation.id, input.embedding, chunks.map((chunk, index) => ({
          chunkId: chunk.id, vector: Array.from({length: input.embedding!.dimensions}, (_, offset) => vectors[index]!.readFloatLE(offset * 4))})));
      }
      const generic = await this.embeddings.prepareSource(input.generic, input.metadata, input.embedding, input.signal);
      return {generation, generic};
    } catch (error) {
      if (generation) this.repository.scientificIndex.fail(generation.id, input.signal.aborted
        ? 'research_scientific_cancelled' : 'research_scientific_embedding_failed', input.signal.aborted);
      throw error;
    }
  }
}
