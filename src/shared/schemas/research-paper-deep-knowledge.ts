import {z} from 'zod';
import {paperIrIdentitySchema, paperIrV2Schema} from './research-paper-ir-v2';
import {scientificIdSchema, scientificSourceProposalSchema, scientificSourceSchema} from './research-scientific-facts';

export const paperDeepDimensionSchema = z.enum(['research_problem', 'core_contribution', 'method',
  'mathematical_formulation', 'algorithm', 'experiments', 'results', 'ablation', 'limitations',
  'open_questions', 'reproducibility']);
export const paperDeepSelectionSchema = z.object({
  purpose: z.enum(['reading', 'writing', 'comparison']), question: z.string().min(1).max(4000),
  dimensions: z.array(paperDeepDimensionSchema).min(1).max(11),
  sectionIds: z.array(scientificIdSchema).max(32), objectIds: z.array(scientificIdSchema).max(32)
}).strict();
export const paperDeepKnowledgeRequestSchema = paperDeepSelectionSchema.extend({
  projectId: scientificIdSchema, documentId: scientificIdSchema
}).strict();
export const paperDeepProvenanceSchema = z.enum(['author_stated', 'source_derived', 'model_inference', 'unknown']);
/** Aspects retain object-specific gaps explicitly; raw objects below remain the source of numerical values. */
export const paperDeepAspectSchema = z.enum(['summary', 'variables', 'units', 'inputs', 'outputs', 'assumptions',
  'referenced_definitions', 'referenced_equations', 'derivation_steps', 'complexity', 'dataset', 'dataset_version',
  'split', 'metric', 'metric_definition', 'baseline', 'raw_result', 'hardware', 'training_budget', 'inference_budget',
  'random_seeds', 'repeats', 'uncertainty', 'caption', 'body_references', 'steps', 'code', 'parameters']);
const claimFields = {
  id: scientificIdSchema, dimension: paperDeepDimensionSchema, aspect: paperDeepAspectSchema,
  objectId: scientificIdSchema.nullable(), provenance: paperDeepProvenanceSchema,
  text: z.string().min(1).max(8000)
};
export const paperDeepClaimProposalSchema = z.object({...claimFields,
  evidence: z.array(scientificSourceProposalSchema).max(30)
}).strict();
const relationFields = {id: scientificIdSchema,
  type: z.enum(['contains_component', 'uses_formula', 'tests_component', 'ablates_component']),
  provenance: z.enum(['author_stated', 'source_derived', 'model_inference'])};
export const paperDeepRelationProposalSchema = z.object({...relationFields,
  from: scientificSourceProposalSchema, to: scientificSourceProposalSchema,
  evidence: z.array(scientificSourceProposalSchema).min(1).max(30)
}).strict();
export const paperDeepExtractionSchema = z.object({
  claims: z.array(paperDeepClaimProposalSchema).max(200),
  relationships: z.array(paperDeepRelationProposalSchema).max(100)
}).strict();
export const paperDeepKnowledgeSchema = z.object({
  version: z.literal(1), identity: paperIrIdentitySchema, request: paperDeepSelectionSchema,
  claims: z.array(z.object({...claimFields, evidence: z.array(scientificSourceSchema).max(30),
    scientificApproval: z.literal('unreviewed')}).strict()).max(2000),
  relationships: z.array(z.object({...relationFields, from: scientificSourceSchema, to: scientificSourceSchema,
    evidence: z.array(scientificSourceSchema).min(1).max(30), scientificApproval: z.literal('unreviewed')}).strict()).max(1000),
  objects: z.object({tables: paperIrV2Schema.shape.tables, figures: paperIrV2Schema.shape.figures,
    equations: paperIrV2Schema.shape.equations, algorithms: paperIrV2Schema.shape.algorithms}).strict(),
  status: z.enum(['source_validated', 'stale']), scientificApproval: z.literal('unreviewed')
}).strict();
export type PaperDeepSelection = z.infer<typeof paperDeepSelectionSchema>;
export type PaperDeepKnowledgeRequest = z.infer<typeof paperDeepKnowledgeRequestSchema>;
export type PaperDeepKnowledge = z.infer<typeof paperDeepKnowledgeSchema>;
export type PaperDeepExtraction = z.infer<typeof paperDeepExtractionSchema>;
