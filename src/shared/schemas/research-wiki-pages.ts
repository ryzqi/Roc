import {z} from 'zod';
import {paperSourceSchema} from './research-paper-card';
import {scientificSourceRefSchema} from './research-scientific-source-ref';

const id = z.string().trim().min(1).max(300);
const ids = z.array(id).max(50).refine(value => new Set(value).size === value.length, 'Duplicate identifiers');
const revision = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const wikiTemplateSchema = z.enum(['paper_source', 'concept', 'method', 'equation', 'algorithm',
  'dataset', 'metric', 'protocol', 'research_synthesis']);
export const wikiLayerSchema = z.enum(['L1', 'L2', 'L3']);
export const wikiSearchFiltersSchema = z.object({
  kinds: z.array(z.enum(['source', 'topic', 'comparison', 'dispute'])).min(1).max(4).optional(),
  layers: z.array(wikiLayerSchema).min(1).max(3).optional(),
  templates: z.array(wikiTemplateSchema).min(1).max(9).optional()
}).strict();
export const wikiScopeSchema = z.object({projectId: id}).strict();
export const wikiPageRequestSchema = wikiScopeSchema.extend({pageId: id}).strict();
export const wikiSearchSchema = wikiScopeSchema.extend({query: z.string().trim().max(300).default(''),
  offset: z.number().int().min(0).max(100000).default(0), ...wikiSearchFiltersSchema.shape}).strict();
export const wikiPaperKnowledgeSourceSchema = z.object({documentId: id, generationId: id}).strict();
const paperKnowledgeSources = z.array(wikiPaperKnowledgeSourceSchema).max(12)
  .refine(value => new Set(value.map(source => source.documentId)).size === value.length, 'Duplicate paper knowledge sources');
const scientificReference = {source: wikiPaperKnowledgeSourceSchema, id: z.string().min(1).max(2048)};
/** References into a verified immutable publication, never model-written scientific values or approval. */
export const wikiScientificStatementSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('fact'), ...scientificReference}).strict(),
  z.object({kind: z.literal('entity'), ...scientificReference}).strict(),
  z.object({kind: z.literal('relation'), ...scientificReference}).strict(),
  z.object({kind: z.literal('object'), ...scientificReference,
    objectType: z.enum(['Table', 'Figure', 'Equation', 'Algorithm'])}).strict(),
  z.object({kind: z.literal('unknown')}).strict()
]);
const scientificReferences = z.array(wikiScientificStatementSchema).min(1).max(30);
export const wikiExplanationDraftSchema = z.object({
  text: z.string().trim().min(1).max(1600),
  kind: z.enum(['source_statement', 'paraphrase', 'comparison', 'inference']),
  references: scientificReferences
}).strict();
export const wikiExplanationStatementSchema = wikiExplanationDraftSchema.extend({
  sourceRefs: z.array(scientificSourceRefSchema).max(100),
  validation: z.enum(['source_validated', 'review_required']),
  semanticSupport: z.enum(['supported', 'unsupported', 'uncertain', 'not_checked']),
  scientificApproval: z.literal('unreviewed')
}).strict();
export const wikiScientificExplanationSchema = z.object({
  version: z.literal(1), goal: z.string().trim().min(1).max(800),
  unresolvedQuestions: z.array(z.string().trim().min(1).max(500)).max(10),
  statements: z.array(wikiExplanationStatementSchema).min(1).max(8)
}).strict();
export const wikiRelationProjectionSchema = z.object({
  type: z.enum(['defines', 'uses', 'extends', 'evaluates_on', 'compares_with', 'supports', 'contradicts', 'related_to']),
  from: wikiScientificStatementSchema, to: wikiScientificStatementSchema,
  evidence: scientificReferences, validation: z.enum(['source_validated', 'review_required']),
  scientificApproval: z.literal('unreviewed'),
  comparison: z.enum(['conditions_match', 'not_directly_comparable']).nullable()
}).strict();
export const wikiRelationProjectionsSchema = z.array(wikiRelationProjectionSchema).max(500);
export const wikiCreateSchema = wikiScopeSchema.extend({title: z.string().trim().min(1).max(300),
  kind: z.enum(['topic', 'comparison', 'dispute']), evidenceIds: ids, claimIds: ids,
  paperKnowledgeSources: paperKnowledgeSources.optional(), template: wikiTemplateSchema.exclude(['paper_source']).optional()}).strict()
  .refine(value => value.evidenceIds.length + value.claimIds.length + (value.paperKnowledgeSources?.length ?? 0) > 0, 'Original sources required');
export const wikiSectionInputSchema = z.object({id, title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(6000), evidenceIds: ids, claimIds: ids, links: ids,
  paperSources: z.array(paperSourceSchema).max(12).optional(),
  paperKnowledgeSources: paperKnowledgeSources.optional(),
  scientificStatements: scientificReferences.optional(), scientificExplanation: wikiScientificExplanationSchema.optional()}).strict();
export const wikiDependencySchema = z.object({kind: z.enum(['evidence', 'claim', 'relations', 'paper', 'paper_knowledge']), id, digest}).strict();
export const wikiSectionSchema = wikiSectionInputSchema.extend({owner: z.enum(['system', 'assistant', 'human']),
  status: z.enum(['current', 'stale']),
  dependencies: z.array(wikiDependencySchema).max(200)}).strict();
export const wikiRevisionSchema = z.object({pageId: id, revision: revision.positive(),
  sections: z.array(wikiSectionSchema).max(100), reason: z.enum(['compile', 'human', 'assistant', 'rollback']),
  createdAt: id}).strict();
export const wikiJobSchema = z.object({generation: id, status: z.enum(['queued', 'running', 'ready', 'failed']),
  error: z.string().nullable()}).strict();
export const wikiSummarySchema = z.object({id, projectId: id, title: z.string(), kind: z.enum(['source', 'topic', 'comparison', 'dispute']),
  revision, updatedAt: id, job: wikiJobSchema.nullable(), layer: wikiLayerSchema.optional(), template: wikiTemplateSchema.optional()}).strict();
export const wikiSearchResultSchema = z.object({
  pages: z.array(wikiSummarySchema.extend({matches: z.array(z.object({
    sectionId: id, title: z.string(), snippet: z.string().max(320)
  }).strict()).max(3)}).strict()).max(50),
  mode: z.enum(['list', 'bm25', 'hybrid']),
  degradation: z.enum(['config_missing', 'index_pending', 'embedding_failed']).nullable(),
  indexedSections: z.number().int().nonnegative(), totalSections: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable()
}).strict();
export const wikiLintSchema = z.object({code: z.enum(['stale', 'missing', 'uncited', 'broken_link', 'conflict_candidate', 'isolated', 'source_limit']),
  sectionId: id.nullable(), message: z.string()}).strict();
export const wikiPageSchema = z.object({page: wikiSummarySchema, current: wikiRevisionSchema.nullable(), basisDigest: digest,
  paperJob: wikiJobSchema.nullable(),
  lint: z.array(wikiLintSchema), sources: z.array(z.object({evidenceId: id, title: z.string(), locator: z.string(),
    excerpt: z.string(), sourceDigest: digest, status: z.enum(['recorded', 'superseded'])}).strict()),
  links: z.array(wikiSummarySchema)}).strict();
export const wikiSaveSchema = wikiPageRequestSchema.extend({expectedRevision: revision.positive(), expectedBasisDigest: digest,
  section: wikiSectionInputSchema}).strict();
export const wikiRollbackSchema = wikiPageRequestSchema.extend({expectedRevision: revision.positive(), targetRevision: revision.positive()}).strict();
export const wikiHistorySchema = wikiPageRequestSchema.extend({offset: z.number().int().min(0).default(0)}).strict();
export const wikiRevisionReadSchema = wikiPageRequestSchema.extend({revision: revision.positive()}).strict();
export const wikiCompileSchema = wikiPageRequestSchema.extend({expectedRevision: revision}).strict();
export const wikiFollowSchema = wikiPageRequestSchema.extend({targetPageId: id, expectedRevision: revision.positive()}).strict();
export const wikiSectionReadSchema = wikiPageRequestSchema.extend({
  sectionId: id, expectedRevision: revision.positive(), offset: z.number().int().min(0).max(6000).default(0),
  maxChars: z.number().int().min(100).max(6000).default(3000)
}).strict();
export const wikiResynthesizeSchema = wikiPageRequestSchema.extend({
  sectionIds: z.array(id).min(1).max(3).refine(value => new Set(value).size === value.length, 'Duplicate sections'),
  expectedRevision: revision.positive(), expectedBasisDigest: digest
}).strict();
export const wikiUpdateSourcesSchema = wikiResynthesizeSchema.extend({
  paperKnowledgeSources: paperKnowledgeSources.min(1)
}).strict();
export const wikiSectionDetailSchema = z.object({page: wikiSummarySchema, basisDigest: digest,
  section: wikiSectionSchema, nextOffset: z.number().int().nonnegative().nullable()}).strict();
export type WikiSection = z.infer<typeof wikiSectionSchema>;
export type WikiPaperKnowledgeSource = z.infer<typeof wikiPaperKnowledgeSourceSchema>;
export type WikiScientificStatement = z.infer<typeof wikiScientificStatementSchema>;
export type WikiDependency = z.infer<typeof wikiDependencySchema>;
export type WikiRevision = z.infer<typeof wikiRevisionSchema>;
export type WikiPage = z.infer<typeof wikiPageSchema>;
export type WikiSummary = z.infer<typeof wikiSummarySchema>;
export type WikiSearchResult = z.infer<typeof wikiSearchResultSchema>;
export type WikiSearchFilters = z.infer<typeof wikiSearchFiltersSchema>;
export type WikiTemplate = z.infer<typeof wikiTemplateSchema>;
export type WikiScientificExplanation = z.infer<typeof wikiScientificExplanationSchema>;
export type WikiExplanationDraft = z.infer<typeof wikiExplanationDraftSchema>;
