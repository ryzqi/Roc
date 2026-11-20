import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {z} from 'zod';
import {scientificEntityProposalSchema,
  type ScientificEntityProposal} from '../../../shared/schemas/research-scientific-entities';
import type {ScientificExtractionBatch} from './scientific-extraction-batches';
import {assertScientificBatchSources} from './scientific-extraction-batches';
import {invokeScientificExtraction, type ScientificExtractionSession} from './scientific-extraction-model';
import {createScientificSourceValidator, scientificKnowledgeId} from './scientific-fact-validator';
import {scientificNameTokens} from './scientific-extraction-input';
import {scientificIdSchema, scientificSourceProposalSchema} from '../../../shared/schemas/research-scientific-facts';

/** Structural selections resolve original fields; historical/persisted proposals retain the full contract. */
const [, method, model, dataset, metric, experiment, baseline] = scientificEntityProposalSchema.options;
const structuralSelections = (['Equation', 'Figure', 'Table', 'Algorithm'] as const).map(entityType =>
  z.object({id: scientificIdSchema, entityType: z.literal(entityType), objectId: scientificIdSchema}).strict());
const nameSelectionSchema = z.object({
  evidenceIndex: z.number().int().nonnegative().max(49),
  firstToken: z.number().int().nonnegative(), lastToken: z.number().int().nonnegative()
}).strict();
const selectedNames = {canonicalName: nameSelectionSchema, aliases: z.array(nameSelectionSchema).max(30)};
const modelEntityExtractionSchema = z.object({
  entities: z.array(z.discriminatedUnion('entityType', [
    method.omit({canonicalName: true, aliases: true}).extend(selectedNames),
    model.omit({canonicalName: true, aliases: true}).extend(selectedNames),
    dataset.omit({canonicalName: true, aliases: true}).extend(selectedNames),
    metric.omit({canonicalName: true, aliases: true}).extend(selectedNames),
    experiment.omit({canonicalName: true, aliases: true}).extend(selectedNames),
    baseline.omit({canonicalName: true, aliases: true}).extend(selectedNames),
    ...structuralSelections
  ])).max(500)
}).strict().refine(value => new Set(value.entities.map(entity => entity.id)).size === value.entities.length,
  'research_scientific_entity_ids_invalid');
const [, ...otherSourceSchemas] = scientificSourceProposalSchema.options;
const selectedTextSources = z.array(z.discriminatedUnion('kind', [
  z.object({kind: z.literal('text_span'), textId: scientificIdSchema}).strict(), ...otherSourceSchemas
])).min(1).max(50);
const wireEntityExtractionSchema = (batch: ScientificExtractionBatch) => z.object({
  entities: z.array(z.discriminatedUnion('entityType', [
    method.omit({evidence: true, canonicalName: true, aliases: true}).extend({...selectedNames, evidence: selectedTextSources}),
    model.omit({evidence: true, canonicalName: true, aliases: true}).extend({...selectedNames, evidence: selectedTextSources}),
    dataset.omit({evidence: true, canonicalName: true, aliases: true}).extend({...selectedNames, evidence: selectedTextSources}),
    metric.omit({evidence: true, canonicalName: true, aliases: true}).extend({...selectedNames, evidence: selectedTextSources}),
    experiment.omit({evidence: true, canonicalName: true, aliases: true}).extend({...selectedNames, evidence: selectedTextSources}),
    baseline.omit({evidence: true, canonicalName: true, aliases: true}).extend({...selectedNames, evidence: selectedTextSources}),
    ...structuralSelections.map(schema => schema.extend({
      // Empty enums retain the type branch while making absent objects unselectable.
      objectId: z.enum(batch.objects.filter(object => object.objectType === schema.shape.entityType.value)
        .map(object => object.objectId))
    }))
  ])).max(500)
}).strict().refine(value => new Set(value.entities.map(entity => entity.id)).size === value.entities.length,
  'research_scientific_entity_ids_invalid');

/** Supply the same original object identity that the publication validator requires. */
function objectEntityConstraints(batch: ScientificExtractionBatch, ir: PaperIRV2): Array<
  Pick<ScientificEntityProposal, 'entityType' | 'canonicalName' | 'attributes'> & {
    requiredEvidence: {kind: 'object'; objectType: ScientificExtractionBatch['objects'][number]['objectType']; objectId: string};
  }> {
  return batch.objects.map(object => {
    const {objectType: entityType, objectId} = object;
    const requiredEvidence = {kind: 'object' as const, objectType: entityType, objectId};
    if (entityType === 'Equation') {
      const equation = ir.equations.find(equation => equation.id === objectId);
      if (!equation) throw new Error('research_scientific_extraction_source_not_supplied');
      const number = equation.data.equationNumber;
      return {entityType, canonicalName: number === null ? objectId : `Equation ${number}`,
        attributes: {objectId, number, latex: equation.data.rawLatex}, requiredEvidence};
    }
    if (entityType === 'Algorithm') {
      if (!ir.algorithms.some(algorithm => algorithm.id === objectId)) {
        throw new Error('research_scientific_extraction_source_not_supplied');
      }
      return {entityType, canonicalName: objectId, attributes: {objectId, inputs: [], outputs: []}, requiredEvidence};
    }
    const table = entityType === 'Table' ? ir.tables.find(table => table.id === objectId) : undefined;
    const figure = entityType === 'Figure' ? ir.figures.find(figure => figure.id === objectId) : undefined;
    if (!table && !figure) throw new Error('research_scientific_extraction_source_not_supplied');
    const number = (table?.visual ?? figure?.data)?.objectNumber ?? table?.data.tableNumber ?? null;
    return {entityType, canonicalName: number === null ? objectId : `${entityType} ${number}`,
      attributes: {objectId, number, caption: null}, requiredEvidence};
  });
}

export function scientificMetadataEntity(ir: PaperIRV2): ScientificEntityProposal {
  const name = ir.metadata.title ?? ir.identity.paperId;
  return {id: scientificKnowledgeId('metadata-candidate', ir.identity), entityType: 'Paper', canonicalName: name, aliases: [],
    attributes: {title: ir.metadata.title, doi: ir.metadata.doi, year: ir.metadata.year},
    evidence: [{kind: 'metadata', field: ir.metadata.title === null ? 'paperId' : 'title', raw: name}]};
}

export async function extractScientificEntities(session: ScientificExtractionSession, batch: ScientificExtractionBatch,
  ir: PaperIRV2, signal: AbortSignal): Promise<ScientificEntityProposal[]> {
  const objectEntities = objectEntityConstraints(batch, ir);
  const output = await invokeScientificExtraction(session, 'scientific_entities', modelEntityExtractionSchema,
    'Extract only Method, Model, Dataset, Metric, Experiment, Baseline, Equation, Figure, Table and Algorithm entities. ' +
    'Paper metadata is supplied separately. Names must occur in the cited sources. Use each complete object exactly as supplied: ' +
    'For Equation, Figure, Table and Algorithm, return only id, entityType and the exact supplied objectId. ' +
    'The host resolves canonicalName, attributes and requiredEvidence from objectEntities; do not output these fields or aliases. ' +
    'For all other entity types, supply the schema attributes and exact source evidence. ' +
    'canonicalName and every alias must select {evidenceIndex, firstToken, lastToken}, never generated name strings. ' +
    'evidenceIndex is the zero-based index in this entity own evidence array. firstToken and lastToken select the ' +
    'numbered nameTokens of that evidence quote, with zero-based indices and lastToken inclusive. Each nameTokens entry ' +
    'is [index, original non-whitespace token]. Select one continuous range that names this entity; the host retains ' +
    'all original punctuation, case, intervening abbreviations, whitespace and split-word hyphens inside that range. ' +
    'For text_span, use the selected block nameTokens; for table_cell, use that exact cell nameTokens. ' +
    'For object or metadata evidence the tokens are the non-whitespace pieces of the original object quote or metadata raw. ' +
    'Omit proposals or aliases without a supported printed name; do not select unrelated words to create a name. ' +
    'Choose entityType from the meaning stated by the original sources. Metric denotes an evaluation measure, ' +
    'Dataset a data collection, Baseline a comparison system, and Method or Model an approach or system. ' +
    'A table row or column label alone does not establish its scientific type; retain evidence that states its meaning. ' +
    'For text evidence, select only kind text_span and the supplied block textId. ' +
    'The host retains that complete supplied interval and its exact original quote and absolute UTF-16 offsets. ' +
    'Do not return blockId, start, end or quote for a text selection, count offsets or rewrite original hyphenation. ' +
    'Cell citations cannot replace object evidence. ' +
    'When number is null, canonicalName is the supplied objectId; never infer a number from order or appearance. ' +
    'Complete raw LaTeX remains in the input and host-resolved candidate. Only linked original captions may be used as object captions. ' +
    'Give each proposal a unique local id. Aliases and version-specific models do not authorize merging.',
    {metadata: ir.metadata, batch, objectEntities}, signal,
    {schema: wireEntityExtractionSchema(batch), textSelections: true, nameSelections: true});
  const sources = createScientificSourceValidator(ir);
  return output.entities.map((selection, ordinal) => {
    let entity: ScientificEntityProposal;
    if ('objectId' in selection) {
      const original = objectEntities.find(object => object.entityType === selection.entityType &&
        object.requiredEvidence.objectId === selection.objectId);
      if (!original) throw new Error('research_scientific_extraction_source_not_supplied');
      entity = scientificEntityProposalSchema.parse({id: selection.id, entityType: original.entityType,
        canonicalName: original.canonicalName, attributes: original.attributes, aliases: [],
        evidence: [original.requiredEvidence]});
    } else {
      assertScientificBatchSources(batch, selection.evidence, ir);
      const evidence = selection.evidence.map(sources.read);
      const readName = (name: z.infer<typeof nameSelectionSchema>): string => {
        const source = evidence[name.evidenceIndex];
        if (!source) throw new Error('research_scientific_extraction_name_selection_invalid');
        const tokens = scientificNameTokens(source.quote), first = tokens[name.firstToken], last = tokens[name.lastToken];
        if (!first || !last || name.lastToken < name.firstToken) {
          throw new Error('research_scientific_extraction_name_selection_invalid');
        }
        return source.quote.slice(first.start, last.end);
      };
      entity = scientificEntityProposalSchema.parse({...selection,
        canonicalName: readName(selection.canonicalName), aliases: selection.aliases.map(readName)});
    }
    assertScientificBatchSources(batch, entity.evidence, ir);
    return {...entity, id: scientificKnowledgeId('entity-candidate', [batch.id, ordinal, entity.id])};
  });
}
