import {z} from 'zod';
import {paperIrArtifactSchema} from './research-paper-ir-v2';
import {scientificGenerationReceiptSchema} from './research-scientific-search';
import {scientificIdSchema, scientificKnowledgeVersion, scientificFactExtractionSchema, scientificFactSchema} from './research-scientific-facts';
import {scientificEntityExtractionSchema, scientificEntitySchema, scientificEntityAliasSchema} from './research-scientific-entities';
import {scientificRelationExtractionSchema, scientificRelationSchema} from './research-scientific-relations';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const scientificExtractionConfigSchema = z.object({
  extractorVersion: z.literal(scientificKnowledgeVersion), promptVersion: scientificIdSchema,
  model: z.object({provider: scientificIdSchema, modelId: scientificIdSchema,
    model: scientificIdSchema, revision: scientificIdSchema}).strict(),
  inputTokens: z.number().int().min(1000).max(64_000),
  batchTokens: z.number().int().min(500).max(16_000)
}).strict();
export const scientificExtractionSnapshotSchema = z.object({
  projectId: scientificIdSchema, source: scientificGenerationReceiptSchema,
  config: scientificExtractionConfigSchema, aliasesHash: hash,
  resolution: z.object({aliases: z.array(scientificEntityAliasSchema).max(500),
    targets: z.array(scientificEntitySchema).max(500)}).strict()
}).strict();
export const scientificKnowledgeCandidatesSchema = z.object({
  entities: scientificEntityExtractionSchema.shape.entities,
  facts: scientificFactExtractionSchema.shape.facts,
  relations: scientificRelationExtractionSchema.shape.relations
}).strict().superRefine((value, context) => {
  for (const key of ['entities', 'facts', 'relations'] as const) {
    if (new Set(value[key].map(item => item.id)).size !== value[key].length) {
      context.addIssue({code: 'custom', message: 'research_scientific_candidate_ids_invalid', path: [key]});
    }
  }
});
export const scientificKnowledgeBundleSchema = z.object({
  entities: z.array(scientificEntitySchema).max(500),
  facts: z.array(scientificFactSchema).max(500),
  relations: z.array(scientificRelationSchema).max(500)
}).strict();
export const scientificExtractionJobSchema = z.object({
  id: scientificIdSchema, generation: z.number().int().positive(),
  snapshot: scientificExtractionSnapshotSchema, inputHash: hash,
  status: z.enum(['queued', 'running', 'published', 'failed', 'cancelled']),
  publication: z.enum(['unpublished', 'active', 'retired']),
  attempts: z.number().int().nonnegative(), error: z.string().nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), publishedAt: z.string().nullable(),
  resultHash: hash.nullable()
}).strict();
export const scientificKnowledgeReadRequestSchema = z.object({
  projectId: scientificIdSchema, documentId: scientificIdSchema, generationId: scientificIdSchema.nullable()
}).strict();
export const scientificKnowledgeReadSchema = z.object({
  currentPaperIR: paperIrArtifactSchema.nullable(),
  latestJob: scientificExtractionJobSchema.nullable(), publishedJob: scientificExtractionJobSchema.nullable(),
  state: z.enum(['missing', 'current', 'stale']),
  configurationError: z.string().nullable().default(null),
  knowledge: scientificKnowledgeBundleSchema.nullable()
}).strict();
export const scientificExtractionDocumentRequestSchema = z.object({
  projectId: scientificIdSchema, documentId: scientificIdSchema
}).strict();
export const scientificExtractionJobsRequestSchema = scientificExtractionDocumentRequestSchema.extend({
  offset: z.number().int().nonnegative().default(0)
}).strict();
export const scientificExtractionJobRequestSchema = scientificExtractionDocumentRequestSchema.extend({
  generationId: scientificIdSchema
}).strict();
export type ScientificKnowledgeReadRequest = z.infer<typeof scientificKnowledgeReadRequestSchema>;
export type ScientificExtractionJobRequest = z.infer<typeof scientificExtractionJobRequestSchema>;
export type ScientificExtractionConfig = z.infer<typeof scientificExtractionConfigSchema>;
export type ScientificExtractionSnapshot = z.infer<typeof scientificExtractionSnapshotSchema>;
export type ScientificExtractionJob = z.infer<typeof scientificExtractionJobSchema>;
export type ScientificKnowledgeCandidates = z.infer<typeof scientificKnowledgeCandidatesSchema>;
export type ScientificKnowledgeBundle = z.infer<typeof scientificKnowledgeBundleSchema>;
export type ScientificKnowledgeRead = z.infer<typeof scientificKnowledgeReadSchema>;
