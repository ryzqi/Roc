import {z} from 'zod';

const id = z.string().trim().min(1).max(300);
const ids = z.array(id).max(50).refine(value => new Set(value).size === value.length, 'Duplicate identifiers');
const revision = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const wikiScopeSchema = z.object({projectId: id}).strict();
export const wikiPageRequestSchema = wikiScopeSchema.extend({pageId: id}).strict();
export const wikiSearchSchema = wikiScopeSchema.extend({query: z.string().trim().max(300).default(''),
  offset: z.number().int().min(0).max(100000).default(0)}).strict();
export const wikiCreateSchema = wikiScopeSchema.extend({title: z.string().trim().min(1).max(300),
  kind: z.enum(['topic', 'comparison', 'dispute']), evidenceIds: ids, claimIds: ids}).strict()
  .refine(value => value.evidenceIds.length + value.claimIds.length > 0, 'Original sources required');
export const wikiSectionInputSchema = z.object({id, title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(6000), evidenceIds: ids, claimIds: ids, links: ids}).strict();
export const wikiDependencySchema = z.object({kind: z.enum(['evidence', 'claim', 'relations']), id, digest}).strict();
export const wikiSectionSchema = wikiSectionInputSchema.extend({owner: z.enum(['human', 'generated']),
  dependencies: z.array(wikiDependencySchema).max(200)}).strict();
export const wikiRevisionSchema = z.object({pageId: id, revision: revision.positive(),
  sections: z.array(wikiSectionSchema).max(100), reason: z.enum(['compile', 'human', 'assistant', 'rollback']),
  createdAt: id}).strict();
export const wikiJobSchema = z.object({generation: id, status: z.enum(['queued', 'running', 'ready', 'failed']),
  error: z.string().nullable()}).strict();
export const wikiSummarySchema = z.object({id, projectId: id, title: z.string(), kind: z.enum(['source', 'topic', 'comparison', 'dispute']),
  revision, updatedAt: id, job: wikiJobSchema.nullable()}).strict();
export const wikiLintSchema = z.object({code: z.enum(['stale', 'missing', 'uncited', 'broken_link', 'conflict_candidate', 'isolated', 'source_limit']),
  sectionId: id.nullable(), message: z.string()}).strict();
export const wikiPageSchema = z.object({page: wikiSummarySchema, current: wikiRevisionSchema.nullable(), basisDigest: digest,
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
export type WikiSection = z.infer<typeof wikiSectionSchema>;
export type WikiDependency = z.infer<typeof wikiDependencySchema>;
export type WikiRevision = z.infer<typeof wikiRevisionSchema>;
export type WikiPage = z.infer<typeof wikiPageSchema>;
export type WikiSummary = z.infer<typeof wikiSummarySchema>;
