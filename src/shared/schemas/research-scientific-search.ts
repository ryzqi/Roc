import {z} from 'zod';
import {scientificQueryPlanSchema, scientificRetrievalChannelSchema} from './research-scientific-query-plan';
import {paperIrArtifactSchema, paperIrMetadataSchema} from './research-paper-ir-v2';
import {researchSourceLocatorSchema} from './research-source-locator';
import {scientificBlockRoleSchema} from './research-paper-structure';
import {paperEquationSchema} from './research-paper-equation';
import {paperVisualSchema} from './research-paper-visual';
import {scholarlyProviderSchema, scholarlyRelationSchema} from './research-scholarly-relations';
import {rerankerReceiptSchema} from './research-reranker';

const id = z.string().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const scientificSearchVersion = 'roc-scientific-search/1';
const scientificSearchRequest = z.object({
  projectId: id.nullable(), query: z.string().trim().min(1).max(4000),
  documentIds: z.array(id).max(1000).default([]),
  embeddingConfigId: id.nullable().default(null),
  rerank: z.enum(['none', 'semantic']).default('semantic'),
  limit: z.number().int().min(1).max(100).default(20),
  candidateLimit: z.number().int().min(1).max(200).default(100)
}).strict();
const validSearchBudget = (value: {candidateLimit: number; limit: number; documentIds: string[]}): boolean =>
  value.candidateLimit >= value.limit && new Set(value.documentIds).size === value.documentIds.length;
export const scientificSearchRequestSchema = scientificSearchRequest.refine(validSearchBudget,
  'research_scientific_search_budget_invalid');
/** Derive before refinement: Zod forbids omit() on a refined object. Runtime supplies project scope. */
export const scientificSearchToolRequestSchema = scientificSearchRequest.omit({projectId: true}).refine(validSearchBudget,
  'research_scientific_search_budget_invalid');
export const scientificEmbeddingReceiptSchema = z.object({
  configId: id, revision: z.number().int().positive(), model: id, dimensions: z.number().int().positive()
}).strict();
export const scientificGenerationReceiptSchema = z.object({
  generationId: id, storageProjectId: id.nullable(), paperIR: paperIrArtifactSchema,
  embedding: scientificEmbeddingReceiptSchema.nullable(), chunksHash: hash, relationsHash: hash,
  ownerHash: hash
}).strict();
export const scientificSelectionSchema = z.object({
  objectId: id, type: z.enum(['paragraph', 'table', 'table_row_group', 'figure', 'equation', 'algorithm', 'caption']),
  span: z.object({start: z.number().int().nonnegative(), end: z.number().int().nonnegative()}).strict().optional(),
  rows: z.array(z.number().int().nonnegative()).optional(), steps: z.array(id).optional()
}).strict();
export const scientificTextSourceSchema = z.object({
  text: z.string(), field: z.string().min(1), locator: researchSourceLocatorSchema
}).strict();
const cell = z.object({
  id, originalId: id, row: z.number().int().nonnegative(), column: z.number().int().nonnegative(),
  text: z.string(), header: z.boolean(), rowSpan: z.number().int().positive(), colSpan: z.number().int().positive(),
  sourceLocator: researchSourceLocatorSchema
}).strict();
export const scientificCandidateObjectSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('text')}).strict(),
  z.object({kind: z.literal('metadata'), metadata: paperIrMetadataSchema}).strict(),
  z.object({kind: z.literal('table'), number: z.string().nullable(), caption: z.string().nullable(),
    rows: z.array(z.number().int().nonnegative()), columns: z.array(z.object({
      index: z.number().int().nonnegative(), header: z.string(), unit: z.string().nullable()
    }).strict()), cells: z.array(cell), footnotes: z.array(z.string())}).strict(),
  z.object({kind: z.literal('equation'), data: paperEquationSchema}).strict(),
  z.object({kind: z.literal('figure'), data: paperVisualSchema}).strict(),
  z.object({kind: z.literal('algorithm'), stepIds: z.array(id)}).strict(),
  z.object({kind: z.literal('citation'), snapshotId: id, contentHash: hash,
    queriedAt: z.string().datetime(), source: scholarlyProviderSchema, relation: scholarlyRelationSchema}).strict()
]);
export const scientificCandidateSchema = z.object({
  id, generationId: id, documentId: id, paperId: id, objectId: id, chunkId: id.nullable(),
  objectType: z.enum(['paragraph', 'table', 'table_row_group', 'figure', 'equation', 'algorithm', 'caption', 'metadata', 'citation']),
  selection: scientificSelectionSchema.nullable(), title: z.string(),
  sectionPath: z.array(z.string()), semanticRoles: z.array(scientificBlockRoleSchema),
  content: z.string(), contentHash: hash, sourceLocator: researchSourceLocatorSchema.nullable(),
  sources: z.array(scientificTextSourceSchema), relationIds: z.array(id),
  object: scientificCandidateObjectSchema,
  signals: z.array(z.object({
    channel: scientificRetrievalChannelSchema, method: z.enum(['fts', 'dense', 'exact', 'lexical', 'snapshot']),
    rank: z.number().int().positive(), score: z.number().finite()
  }).strict()).min(1),
  score: z.number().finite().nonnegative()
}).strict();
export const scientificChannelReceiptSchema = z.object({
  channel: scientificRetrievalChannelSchema, limit: z.number().int().positive(),
  returned: z.number().int().nonnegative(), status: z.enum(['ok', 'empty', 'degraded']),
  degradation: z.array(z.string().min(1)), elapsedMs: z.number().finite().nonnegative()
}).strict();
export const scientificSearchResultSchema = z.object({
  version: z.literal(scientificSearchVersion), plan: scientificQueryPlanSchema,
  snapshot: z.object({id: hash, generations: z.array(scientificGenerationReceiptSchema).max(1000)}).strict(),
  channels: z.array(scientificChannelReceiptSchema).max(6),
  candidates: z.array(scientificCandidateSchema).max(1200),
  hits: z.array(scientificCandidateSchema).max(100),
  ranking: z.object({method: z.enum(['rrf', 'reranker']), k: z.literal(60),
    fusionVersion: z.literal('roc-scientific-fusion/1').default('roc-scientific-fusion/1'),
    reranker: rerankerReceiptSchema.default({status: 'not_requested', model: null, configHash: null, elapsedMs: 0}),
    rerank: z.object({
      inputVersion: z.literal('roc-scientific-rerank/1'), inputHash: hash.nullable(),
      scores: z.array(z.object({candidateId: id, score: z.number().finite().min(0).max(1)}).strict()).max(1200),
      degradation: z.array(z.string().min(1)),
      skipped: z.array(z.object({candidateId: id, reason: z.string().min(1)}).strict()).max(1200).default([])
    }).strict().nullable().default(null)
  }).strict()
}).strict();
export type ScientificSearchRequest = z.infer<typeof scientificSearchRequestSchema>;
export type ScientificSearchResult = z.infer<typeof scientificSearchResultSchema>;
export type ScientificCandidate = z.infer<typeof scientificCandidateSchema>;
export type ScientificGenerationReceipt = z.infer<typeof scientificGenerationReceiptSchema>;
export type ScientificChannelReceipt = z.infer<typeof scientificChannelReceiptSchema>;
