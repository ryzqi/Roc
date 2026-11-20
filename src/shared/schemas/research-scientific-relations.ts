import {z} from 'zod';
import {scientificIdSchema, scientificSourcesProposalSchema, scientificSourceSchema} from './research-scientific-facts';

export const scientificRelationTypeSchema = z.enum(['PROPOSES', 'USES', 'EVALUATES_WITH', 'CONTAINS']);
export const scientificRelationProposalSchema = z.object({
  id: scientificIdSchema, type: scientificRelationTypeSchema,
  fromEntityId: scientificIdSchema, toEntityId: scientificIdSchema,
  factIds: z.array(scientificIdSchema).max(50), evidence: scientificSourcesProposalSchema
}).strict();
export const scientificRelationExtractionSchema = z.object({
  relations: z.array(scientificRelationProposalSchema).max(500)
}).strict().refine(value => new Set(value.relations.map(r => r.id)).size === value.relations.length,
  'research_scientific_relation_ids_invalid');
export const scientificRelationSchema = z.object({
  id: scientificIdSchema, candidateId: scientificIdSchema, projectId: scientificIdSchema,
  paperId: scientificIdSchema, documentId: scientificIdSchema, generationId: scientificIdSchema,
  type: scientificRelationTypeSchema, fromEntityId: scientificIdSchema, toEntityId: scientificIdSchema,
  factIds: z.array(scientificIdSchema).max(50), evidence: z.array(scientificSourceSchema).min(1).max(50),
  status: z.enum(['source_validated', 'stale']), scientificApproval: z.literal('unreviewed')
}).strict();
export type ScientificRelationProposal = z.infer<typeof scientificRelationProposalSchema>;
export type ScientificRelation = z.infer<typeof scientificRelationSchema>;
