import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import type {ScientificEntityProposal} from '../../../shared/schemas/research-scientific-entities';
import type {ScientificFactProposal} from '../../../shared/schemas/research-scientific-facts';
import {scientificRelationExtractionSchema, type ScientificRelationProposal} from '../../../shared/schemas/research-scientific-relations';
import {assertScientificBatchSources, type ScientificExtractionBatch} from './scientific-extraction-batches';
import {invokeScientificExtraction, type ScientificExtractionSession} from './scientific-extraction-model';
import {scientificKnowledgeId} from './scientific-fact-validator';

export async function extractScientificRelations(session: ScientificExtractionSession, batch: ScientificExtractionBatch,
  ir: PaperIRV2, entities: readonly ScientificEntityProposal[], facts: readonly ScientificFactProposal[],
  signal: AbortSignal): Promise<ScientificRelationProposal[]> {
  const output = await invokeScientificExtraction(session, 'scientific_relations', scientificRelationExtractionSchema,
    'Extract only explicitly sourced PROPOSES, USES, EVALUATES_WITH and CONTAINS relations among the supplied entity IDs. ' +
    'Use supplied fact IDs when relevant. Paper PROPOSES Method/Model/Algorithm; Experiment/Method/Model USES Dataset; ' +
    'Experiment EVALUATES_WITH Metric; Method/Model CONTAINS Method/Model/Algorithm/Equation. ' +
    'Semantic similarity alone is not a relation. Do not approve claims or synthesize Wiki prose. Use unique local ids.',
    {metadata: ir.metadata, batch, entities, facts}, signal);
  const entityIds = new Set(entities.map(entity => entity.id)), factIds = new Set(facts.map(fact => fact.id));
  return output.relations.map((relation, ordinal) => {
    if (!entityIds.has(relation.fromEntityId) || !entityIds.has(relation.toEntityId) ||
      relation.factIds.some(id => !factIds.has(id))) throw new Error('research_scientific_extraction_relation_not_supplied');
    assertScientificBatchSources(batch, relation.evidence, ir);
    return {...relation, id: scientificKnowledgeId('relation-candidate', [batch.id, ordinal, relation.id])};
  });
}
