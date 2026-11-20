import {z} from 'zod';
import {scientificSearchResultSchema, scientificCandidateSchema, scientificCandidateObjectSchema,
  scientificSelectionSchema, scientificTextSourceSchema} from './research-scientific-search';
import {researchSourceLocatorSchema} from './research-source-locator';

const id = z.string().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const scientificContextVersion = 'roc-scientific-context/1';
export const scientificContextBudgetSchema = z.object({
  maxObjects: z.number().int().min(1).max(50).default(12),
  maxParagraphs: z.number().int().min(0).max(100).default(24),
  maxTokens: z.number().int().min(32).max(64_000).default(8000),
  maxImages: z.number().int().min(0).max(10).default(2),
  maxImageDimension: z.number().int().min(64).max(4096).default(2048),
  maxEvidencePerPaper: z.number().int().min(1).max(50).default(4)
}).strict();
export const scientificContextRequestSchema = z.object({
  search: scientificSearchResultSchema,
  candidateIds: z.array(id).max(100).default([]),
  budget: scientificContextBudgetSchema.default(scientificContextBudgetSchema.parse({}))
}).strict().refine(value => new Set(value.candidateIds).size === value.candidateIds.length,
  'research_scientific_context_selection_invalid');
export const scientificContextPassageSchema = z.object({
  role: z.enum(['parent', 'adjacent', 'section_heading', 'experimental_setup', 'explanation',
    'symbol_definition', 'caption', 'reference']),
  text: z.string().min(1), sourceLocator: researchSourceLocatorSchema
}).strict();
export const scientificContextImageSchema = z.object({
  storage: z.enum(['library', 'project']), assetId: id.nullable(), path: id,
  sha256: hash, size: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  sourceLocator: researchSourceLocatorSchema
}).strict();
export const scientificContextEvidenceSchema = z.object({
  id, candidateIds: z.array(id).min(1).max(100), generationId: id,
  documentId: id, paperId: id, objectId: id,
  objectType: scientificCandidateSchema.shape.objectType,
  title: z.string(), sectionPath: z.array(z.string()),
  hits: z.array(z.object({
    chunkId: id, selection: scientificSelectionSchema,
    content: z.string(), sources: z.array(scientificTextSourceSchema)
  }).strict()).min(1).max(100),
  object: scientificCandidateObjectSchema,
  passages: z.array(scientificContextPassageSchema).max(100),
  image: scientificContextImageSchema.nullable()
}).strict();
export const scientificContextResultSchema = z.object({
  version: z.literal(scientificContextVersion), id: hash, snapshotId: hash,
  projectId: id.nullable(), query: z.string(),
  selectedCandidateIds: z.array(id).max(100), budget: scientificContextBudgetSchema,
  evidence: z.array(scientificContextEvidenceSchema).max(50),
  usage: z.object({
    objects: z.number().int().nonnegative(), paragraphs: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(), images: z.number().int().nonnegative()
  }).strict(),
  omissions: z.array(z.object({candidateIds: z.array(id), reason: z.string().min(1)}).strict()),
  requestedConditions: z.object({datasets: z.array(z.string()), metrics: z.array(z.string()),
    splits: z.array(z.string())}).strict(),
  comparisonStatus: z.literal('requires_validation')
}).strict();
export type ScientificContextRequest = z.infer<typeof scientificContextRequestSchema>;
export type ScientificContextResult = z.infer<typeof scientificContextResultSchema>;
export type ScientificContextEvidence = z.infer<typeof scientificContextEvidenceSchema>;
export type ScientificContextPassage = z.infer<typeof scientificContextPassageSchema>;
export type ScientificContextImage = z.infer<typeof scientificContextImageSchema>;
export type ScientificContextBudget = z.infer<typeof scientificContextBudgetSchema>;
