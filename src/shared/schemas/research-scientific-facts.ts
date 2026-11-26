import {z} from 'zod';
import {paperIrIdentitySchema} from './research-paper-ir-v2';
import {researchSourceLocatorSchema} from './research-source-locator';

export const scientificKnowledgeVersion = 'roc-scientific-knowledge/1';
export const scientificIdSchema = z.string().min(1).max(2048);
const text = z.string().min(1).max(16_000);
const row = z.number().int().nonnegative();

/** Model references select supplied sources; only the program supplies locators and validation status. */
export const scientificSourceProposalSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('text'), blockId: scientificIdSchema, start: row,
    end: z.number().int().positive(), quote: text}).strict(),
  z.object({kind: z.literal('table_cell'), tableId: scientificIdSchema,
    cellId: scientificIdSchema, raw: z.string().max(16_000)}).strict(),
  z.object({kind: z.literal('object'), objectType: z.enum(['Equation', 'Figure', 'Table', 'Algorithm']),
    objectId: scientificIdSchema}).strict(),
  z.object({kind: z.literal('metadata'), field: z.enum(['paperId', 'title', 'doi', 'year', 'author']), raw: text}).strict()
]);
export const scientificSourcesProposalSchema = z.array(scientificSourceProposalSchema).min(1).max(50);
export const scientificSourceSchema = z.object({
  proposal: scientificSourceProposalSchema, identity: paperIrIdentitySchema,
  locator: researchSourceLocatorSchema.nullable(), quote: z.string(),
  tableId: scientificIdSchema.nullable(), rowId: scientificIdSchema.nullable(),
  row: row.nullable(), column: row.nullable(), cellId: scientificIdSchema.nullable()
}).strict();
export const scientificExtendedConditionFields = [
  'hardware', 'trainingBudget', 'inferenceBudget', 'randomSeeds', 'repeats', 'uncertainty'
] as const;
export const scientificStringConditionFields = ['datasetVersion', 'split', 'budget',
  ...scientificExtendedConditionFields] as const;
const extendedConditions = Object.fromEntries(scientificExtendedConditionFields.map(field => [field, text.optional()])) as
  Record<typeof scientificExtendedConditionFields[number], z.ZodOptional<typeof text>>;
export const scientificConditionsSchema = z.object({
  datasetId: scientificIdSchema.nullable(), datasetVersion: text, split: text,
  metricId: scientificIdSchema.nullable(), baselineId: scientificIdSchema.nullable(), budget: text,
  ...extendedConditions,
  other: z.record(z.string().min(1).max(200), z.string().min(1).max(2000))
}).strict();
export const scientificConditionEvidenceProposalSchema = z.object({
  field: z.enum(['datasetId', 'metricId', 'baselineId', ...scientificStringConditionFields, 'other']),
  key: z.string().min(1).max(200).nullable(), evidence: scientificSourcesProposalSchema
}).strict();
const types = ['research_problem', 'contribution', 'method_component', 'dataset_usage',
  'metric_definition', 'experimental_result', 'limitation'] as const;
export const scientificFactProposalSchema = z.object({
  id: scientificIdSchema, factType: z.enum(types), subjectEntityId: scientificIdSchema.nullable(),
  predicate: text, objectEntityId: scientificIdSchema.nullable(),
  value: z.object({raw: text, unit: text.nullable(),
    unitEvidence: z.array(scientificSourceProposalSchema).max(10)}).strict().nullable(),
  conditions: scientificConditionsSchema,
  conditionEvidence: z.array(scientificConditionEvidenceProposalSchema).max(32),
  table: z.object({tableId: scientificIdSchema, row: row, cellId: scientificIdSchema}).strict().nullable(),
  evidence: scientificSourcesProposalSchema, confidence: z.number().min(0).max(1)
}).strict().refine(value => value.factType !== 'experimental_result' || value.value !== null && value.table !== null,
  'research_scientific_result_cell_required');
export const scientificFactExtractionSchema = z.object({
  facts: z.array(scientificFactProposalSchema).max(500)
}).strict().refine(value => new Set(value.facts.map(f => f.id)).size === value.facts.length,
  'research_scientific_fact_ids_invalid');
export const scientificFactSchema = z.object({
  id: scientificIdSchema, candidateId: scientificIdSchema, projectId: scientificIdSchema,
  paperId: scientificIdSchema, documentId: scientificIdSchema, generationId: scientificIdSchema,
  factType: z.enum(types), subjectEntityId: scientificIdSchema.nullable(), predicate: text,
  objectEntityId: scientificIdSchema.nullable(),
  value: z.object({raw: text, normalized: text.nullable(), rawUnit: text.nullable(), unit: text.nullable(),
    unitEvidence: z.array(scientificSourceSchema).max(20)}).strict().nullable(),
  conditions: scientificConditionsSchema,
  conditionEvidence: z.array(z.object({
    field: scientificConditionEvidenceProposalSchema.shape.field, key: z.string().nullable(),
    evidence: z.array(scientificSourceSchema).min(1).max(50)
  }).strict()).max(32),
  table: z.object({tableId: scientificIdSchema, rowId: scientificIdSchema, row: row,
    cellId: scientificIdSchema}).strict().nullable(),
  evidence: z.array(scientificSourceSchema).min(1).max(50), confidence: z.number().min(0).max(1),
  status: z.enum(['candidate', 'source_validated', 'review_required', 'rejected', 'stale']),
  scientificApproval: z.literal('unreviewed'),
  comparisonStatus: z.literal('requires_review')
}).strict();
export type ScientificSourceProposal = z.infer<typeof scientificSourceProposalSchema>;
export type ScientificSource = z.infer<typeof scientificSourceSchema>;
export type ScientificFactProposal = z.infer<typeof scientificFactProposalSchema>;
export type ScientificFact = z.infer<typeof scientificFactSchema>;
