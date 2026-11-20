import type {ResearchRepository} from './repository';
import type {ResearchEmbeddingService} from './embedding-service';
import type {ScientificSearchSnapshots} from './scientific-search-snapshot';
import {scientificGenerationActivateSchema, scientificGenerationsRequestSchema,
  type ScientificGenerationActivate, type ScientificGenerationsRequest,
  type ScientificGenerationsResult} from '../../../shared/schemas/research-scientific-generations';

/** Explicit maintenance capability; never exposed as an agent retrieval tool. */
export class ScientificGenerationService {
  constructor(private readonly repository: ResearchRepository,
    private readonly embeddings: Pick<ResearchEmbeddingService, 'selectedIdentity'>,
    private readonly snapshots: ScientificSearchSnapshots) {}

  list(input: ScientificGenerationsRequest): ScientificGenerationsResult {
    const request = scientificGenerationsRequestSchema.parse(input);
    const active = this.authorize(request);
    const rows = this.repository.scientificIndex.history(request.storageProjectId, request.documentId);
    return {...request, activeGeneration: active.id, candidateGeneration: rows.find(g => g.status === 'building')?.id ?? null,
      generations: rows.map(g => ({id: g.id, status: g.status, parseId: g.snapshot.paperIR.identity.parseId,
        sourceHash: g.snapshot.paperIR.identity.sourceHash, paperIRHash: g.snapshot.paperIR.sha256,
        chunkVersion: g.snapshot.chunkVersion, embedding: g.snapshot.embedding, policy: g.snapshot.policy,
        chunkCount: g.chunkCount, createdAt: g.createdAt, publishedAt: g.publishedAt}))};
  }

  async activate(input: ScientificGenerationActivate, signal: AbortSignal = new AbortController().signal): Promise<ScientificGenerationsResult> {
    const request = scientificGenerationActivateSchema.parse(input);
    const active = this.authorize(request);
    if (active.id !== request.expectedActiveId) throw new Error('research_scientific_active_changed');
    const target = this.repository.scientificIndex.get(request.generationId);
    if (target.snapshot.projectId !== request.storageProjectId || target.snapshot.paperIR.identity.documentId !== request.documentId) {
      throw new Error('research_scientific_scope_invalid');
    }
    const guard = await this.snapshots.guardRetainedSource(request.projectId, target, signal);
    this.repository.scientificIndex.activateRetired(target.id, active.id, () => {
      guard(); this.authorize(request);
      return {paperIR: target.snapshot.paperIR, embedding: this.embeddings.selectedIdentity(null)};
    });
    return this.list({projectId: request.projectId, documentId: request.documentId, storageProjectId: request.storageProjectId});
  }

  private authorize(request: ScientificGenerationsRequest) {
    const active = this.snapshots.catalog(request.projectId, [request.documentId]).find(g =>
      g.snapshot.projectId === request.storageProjectId && g.snapshot.paperIR.identity.documentId === request.documentId);
    if (!active) throw new Error('research_scientific_scope_invalid');
    this.snapshots.assertOwner(request.projectId, active);
    return active;
  }
}
