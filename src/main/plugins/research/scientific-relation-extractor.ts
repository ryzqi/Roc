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
    'Extract only explicitly sourced PROPOSES, USES, EVALUATES_WITH, CONTAINS, DEFINES, EXTENDS, EVALUATES_ON, ' +
    'COMPARES_WITH, SUPPORTS, CONTRADICTS and RELATED_TO relations among supplied entity IDs. ' +
    'Use supplied fact IDs when relevant. Paper PROPOSES Method/Model/Algorithm; Experiment/Method/Model USES Dataset; ' +
    'Experiment EVALUATES_WITH Metric; Method/Model CONTAINS Method/Model/Algorithm/Equation. ' +
    'New semantic types require original source statements naming both endpoints. Method/Model/Algorithm may USES ' +
    'Dataset/Method/Model/Algorithm/Equation/Metric or EVALUATES_ON Dataset. Paper/Method/Model DEFINES a technical entity. ' +
    'EXTENDS and COMPARES_WITH connect Method/Model/Algorithm/Baseline. SUPPORTS and CONTRADICTS connect ' +
    'Paper/Experiment/Method/Model/Algorithm/Baseline and need supplied supporting Fact IDs. ' +
    'COMPARES_WITH and CONTRADICTS require at least two experimental result Facts naming both subjects, with identical ' +
    'dataset, version, split, metric, unit, baseline, budget, hardware, trainingBudget, inferenceBudget, randomSeeds, repeats, ' +
    'uncertainty and other conditions; unknown conditions prohibit those links. Use RELATED_TO if a specific relation is unresolved. ' +
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
