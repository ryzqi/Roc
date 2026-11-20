import {z} from 'zod';
import {scientificIdSchema, scientificSourcesProposalSchema, scientificSourceSchema} from './research-scientific-facts';
import {equationLatexLimit} from './research-paper-equation';

const name = z.string().min(1).max(2000);
const optionalText = name.nullable();
const base = {
  id: scientificIdSchema, canonicalName: name, aliases: z.array(name).max(30),
  evidence: scientificSourcesProposalSchema
};
export const scientificEntityTypeSchema = z.enum([
  'Paper', 'Method', 'Model', 'Dataset', 'Metric', 'Experiment', 'Baseline', 'Equation', 'Figure', 'Table', 'Algorithm'
]);
/** Each core type has its own bounded attributes; arbitrary ontology keys are rejected. */
export const scientificEntityProposalSchema = z.discriminatedUnion('entityType', [
  z.object({...base, entityType: z.literal('Paper'), attributes: z.object({
    title: optionalText, doi: optionalText, year: z.number().int().nullable()
  }).strict()}).strict(),
  z.object({...base, entityType: z.literal('Method'), attributes: z.object({description: optionalText}).strict()}).strict(),
  z.object({...base, entityType: z.literal('Model'), attributes: z.object({
    architecture: optionalText, version: optionalText, components: z.array(name).max(50)
  }).strict()}).strict(),
  z.object({...base, entityType: z.literal('Dataset'), attributes: z.object({version: optionalText, task: optionalText}).strict()}).strict(),
  z.object({...base, entityType: z.literal('Metric'), attributes: z.object({
    definition: optionalText, direction: z.enum(['higher', 'lower', 'unknown']), unit: optionalText
  }).strict()}).strict(),
  z.object({...base, entityType: z.literal('Experiment'), attributes: z.object({
    configuration: optionalText, conditions: z.record(name, name)
  }).strict()}).strict(),
  z.object({...base, entityType: z.literal('Baseline'), attributes: z.object({version: optionalText}).strict()}).strict(),
  z.object({...base, entityType: z.literal('Equation'), attributes: z.object({
    objectId: scientificIdSchema, number: optionalText, latex: z.string().max(equationLatexLimit).nullable()
  }).strict()}).strict(),
  ...(['Figure', 'Table'] as const).map(entityType => z.object({...base, entityType: z.literal(entityType),
    attributes: z.object({objectId: scientificIdSchema, number: optionalText, caption: optionalText}).strict()}).strict()),
  z.object({...base, entityType: z.literal('Algorithm'), attributes: z.object({
    objectId: scientificIdSchema, inputs: z.array(name).max(50), outputs: z.array(name).max(50)
  }).strict()}).strict()
]);
export const scientificEntityExtractionSchema = z.object({
  entities: z.array(scientificEntityProposalSchema).max(500)
}).strict().refine(value => new Set(value.entities.map(e => e.id)).size === value.entities.length,
  'research_scientific_entity_ids_invalid');
export const scientificEntityIdentitySchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('literature'), identity: scientificIdSchema, aliases: z.array(scientificIdSchema)}).strict(),
  z.object({kind: z.literal('object'), documentId: scientificIdSchema, objectId: scientificIdSchema}).strict(),
  z.object({kind: z.literal('source'), documentId: scientificIdSchema,
    provenanceHash: z.string().regex(/^[a-f0-9]{64}$/u)}).strict(),
  z.object({kind: z.literal('alias'), aliasId: scientificIdSchema, revision: z.number().int().positive(),
    targetEntityId: scientificIdSchema}).strict()
]);
export const scientificEntitySchema = z.object({
  id: scientificIdSchema, candidateId: scientificIdSchema, projectId: scientificIdSchema,
  paperId: scientificIdSchema, documentId: scientificIdSchema, generationId: scientificIdSchema,
  entityType: scientificEntityTypeSchema, canonicalName: name, aliases: z.array(name).max(30),
  proposal: scientificEntityProposalSchema, evidence: z.array(scientificSourceSchema).min(1).max(50),
  scope: z.literal('project'), identityBasis: scientificEntityIdentitySchema,
  resolutionStatus: z.enum(['exact', 'source_scoped', 'alias', 'conflict']),
  status: z.enum(['source_validated', 'stale']), scientificApproval: z.literal('unreviewed')
}).strict();
/** Only an explicit human-maintained entry can merge names across different sources. */
export const scientificEntityAliasSchema = z.object({
  id: scientificIdSchema, projectId: scientificIdSchema, entityType: scientificEntityTypeSchema,
  alias: name, targetEntityId: scientificIdSchema, canonicalName: name,
  revision: z.number().int().positive(), createdBy: scientificIdSchema
}).strict();
export type ScientificEntityProposal = z.infer<typeof scientificEntityProposalSchema>;
export type ScientificEntity = z.infer<typeof scientificEntitySchema>;
export type ScientificEntityAlias = z.infer<typeof scientificEntityAliasSchema>;
