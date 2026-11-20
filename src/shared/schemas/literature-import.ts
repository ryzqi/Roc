import { z } from 'zod';
import {literatureIngestionPolicySchema} from './literature-acquisition';
import { researchLiteratureSchema } from './research';
import {zoteroItemKeySchema} from './research-zotero';
import {literatureIdentifierObservationSchema, literatureRawIdentifiersSchema} from './literature-identifiers';
import {literatureReviewSchema} from './literature-review';
import {zoteroCitationKeyMappingSchema} from './zotero-citation-key';

export const literatureNetworkSourceSchema = z.enum(['openalex', 'crossref', 'semantic_scholar', 'arxiv', 'pubmed', 'europe_pmc', 'openreview', 'acl', 'dblp', 'cvf']);
export const literatureCollectionsSchema = z.object({
  acl: z.string().regex(/^(?:[A-Z]\d{2}|20\d{2}\.[a-z][a-z0-9-]*)$/u).optional(),
  cvf: z.string().regex(/^(?:CVPR|ICCV|WACV)20(?:2[1-9]|[3-9]\d)$/u).optional()
}).strict();
export function hasExplicitLiteratureCollections(input: {sources?: string[]; collections?: {acl?: string; cvf?: string}}): boolean {
  return (!input.sources?.includes('acl') || input.collections?.acl !== undefined) &&
    (!input.sources?.includes('cvf') || input.collections?.cvf !== undefined);
}
export const literatureSearchToolSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  sources: z.array(literatureNetworkSourceSchema).min(1).max(10).optional()
    .describe('Omit for domain routing; explicit sources are always preserved.'),
  limit: z.number().int().min(1).max(30).default(10),
  maxPages: z.number().int().min(1).max(3).default(1),
  yearFrom: z.number().int().min(1000).max(9999).optional(),
  yearTo: z.number().int().min(1000).max(9999).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  collections: literatureCollectionsSchema.optional().describe('Official collection scope for ACL/CVF; planner can fill omitted scopes, approved queries must specify them. CVF supports 2021 onward.'),
  rerank: z.enum(['none', 'lexical']).optional()
}).strict()
  .refine(input => input.yearFrom === undefined || input.yearTo === undefined || input.yearFrom <= input.yearTo, 'literature_year_range_invalid')
  .refine(input => {
    const from = [input.dateFrom, input.yearFrom === undefined ? undefined : `${input.yearFrom}-01-01`].filter(value => value !== undefined).sort().at(-1);
    const to = [input.dateTo, input.yearTo === undefined ? undefined : `${input.yearTo}-12-31`].filter(value => value !== undefined).sort().at(0);
    return from === undefined || to === undefined || from <= to;
  }, 'literature_date_range_invalid');
export const literatureSearchInputSchema = literatureSearchToolSchema.safeExtend({ projectId: z.string().min(1).nullable().optional() });
/** Persisted requests must identify the sources actually executed, without inferred defaults. */
export const literatureResolvedSearchInputSchema = literatureSearchInputSchema.safeExtend({
  sources: z.array(literatureNetworkSourceSchema).min(1).max(10)
});
export const literatureQueryPlanInputSchema = literatureSearchToolSchema.safeExtend({
  mode: z.enum(['quick', 'deep']).default('quick'),
  recentYears: z.number().int().min(1).max(100).optional(),
  asOf: z.iso.date().optional()
}).refine(input => input.recentYears === undefined ||
  [input.dateFrom, input.dateTo, input.yearFrom, input.yearTo].every(value => value === undefined),
'literature_relative_date_conflict');
export const literatureSearchStrategyReceiptSchema = z.object({
  artifactId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  approvedAt: z.string(), researchQuestion: z.string().min(1), planVersion: z.number().int().positive(),
  queryId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  perspectiveIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)).min(1).max(6),
}).strict();
export const literatureRecordedStrategySchema = z.union([
  literatureSearchStrategyReceiptSchema,
  z.object({kind: z.literal('historical'), auditId: z.string().regex(/^[a-f0-9]{64}$/u),
    reason: z.literal('historical_search_plan_not_authorized')}).strict()
]);
export const literatureCandidateSchema = z.object({
  candidateId: z.string(), identity: z.string(), record: researchLiteratureSchema,
  aliases: z.array(z.string().min(1)).min(1),
  identityConflicts: z.array(z.object({alias: z.string().min(1), doiIdentities: z.array(z.string().startsWith('doi:')).min(2)}).strict()),
  score: z.number().nonnegative(),
  selectionReason: z.literal('source_priority_then_rank_then_metadata_hash'),
  origins: z.array(z.object({ source: literatureNetworkSourceSchema, externalId: z.string(), rank: z.number().int().positive(),
    retrievedAt: z.string(), metadataHash: z.string(), record: researchLiteratureSchema,
    identifiers: z.array(literatureIdentifierObservationSchema), rawIdentifiers: literatureRawIdentifiersSchema.nullable(),
    review: literatureReviewSchema }).strict()).min(1),
  contributions: z.array(z.object({ source: literatureNetworkSourceSchema, rank: z.number().int().positive(), score: z.number().positive() }).strict()),
  conflicts: z.array(z.object({ field: z.enum(['doi', 'title', 'authors', 'publishedYear', 'citationCount', 'url', 'openAccessUrl']),
    values: z.array(z.object({ source: literatureNetworkSourceSchema, externalId: z.string(),
      value: z.union([z.string(), z.number(), z.array(z.string())]) }).strict()).min(2) }).strict()),
  matchedLibraryItemId: z.string().nullable(), archived: z.boolean(), missingFields: z.array(z.string()),
  versionRelations: z.array(z.object({
    kind: z.literal('arxiv_later_version'), arxivId: z.string().min(1),
    older: z.object({externalId: z.string().min(1), metadataHash: z.string().regex(/^[a-f0-9]{64}$/u), version: z.number().int().positive()}).strict(),
    newer: z.object({externalId: z.string().min(1), metadataHash: z.string().regex(/^[a-f0-9]{64}$/u), version: z.number().int().positive()}).strict()
  }).strict().refine(relation => relation.older.version < relation.newer.version, 'literature_version_order_invalid'))
}).strict();
export const literatureRankingSchema = z.object({
  method: z.literal('rrf'), version: z.literal(1), k: z.literal(60),
  sourceWeights: z.array(z.object({source: literatureNetworkSourceSchema, weight: z.literal(1)}).strict())
}).strict();
export const literatureProviderRequestSchema = z.object({
  attempt: z.number().int().positive(), method: z.literal('GET'), url: z.string().url(),
  startedAt: z.string(), endedAt: z.string().nullable(),
  status: z.number().int().min(100).max(599).nullable(), retryAfterMs: z.number().nonnegative().nullable(),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), errorCode: z.string().nullable()
}).strict();
export const literatureProviderGovernanceSchema = z.object({
  host: z.string().min(1), state: z.enum(['unknown', 'healthy', 'degraded', 'cooldown', 'quota_exhausted']),
  consecutiveFailures: z.number().int().nonnegative(), remainingRequests: z.number().int().nonnegative(),
  quotaResetAt: z.string(), minIntervalMs: z.number().nonnegative(), cooldownUntil: z.string().nullable(),
  lastSuccessAt: z.string().nullable(), lastFailureAt: z.string().nullable()
}).strict();
export const literaturePagePositionSchema = z.discriminatedUnion('kind', [
    z.object({kind: z.literal('page'), value: z.number().int().positive()}).strict(),
    z.object({kind: z.literal('offset'), value: z.number().int().nonnegative()}).strict(),
    z.object({kind: z.literal('cursor'), value: z.string().min(1).max(2048)}).strict()
  ]);
export const literatureCacheObservationSchema = z.discriminatedUnion('state', [
  z.object({state: z.literal('miss')}).strict(),
  z.object({state: z.literal('hit'), fetchedAt: z.string(), responseHash: z.string().regex(/^[a-f0-9]{64}$/u)}).strict()
]);
export const literatureProviderCoverageSchema = z.object({
  apiHitCount: z.number().int().nonnegative().nullable(), validatedPages: z.number().int().nonnegative(),
  state: z.enum(['unknown', 'limited', 'reported_end', 'failed']),
  nextPage: literaturePagePositionSchema.nullable()
}).strict();
export const literatureSearchResultSchema = z.object({
  schemaVersion: z.literal(14), ranking: literatureRankingSchema, executionId: z.string().min(1),
  strategy: literatureRecordedStrategySchema.nullable(),
  searchId: z.string(), createdAt: z.string(), expiresAt: z.string(), status: z.enum(['complete', 'partial', 'failed']),
  candidates: z.array(literatureCandidateSchema),
  sources: z.array(z.object({ source: literatureNetworkSourceSchema, status: z.enum(['ok', 'empty', 'partial', 'timeout', 'rate_limited', 'error']),
    returnedCount: z.number().int().nonnegative(), errorCode: z.string().nullable(), retryAfterMs: z.number().nullable(),
    requests: z.array(literatureProviderRequestSchema),
    governance: literatureProviderGovernanceSchema,
    coverage: literatureProviderCoverageSchema,
    stopReason: z.enum(['reported_end', 'page_limit', 'provider_limit', 'continuation_unavailable', 'failed']),
    pages: z.array(z.object({
      position: literaturePagePositionSchema, rankOffset: z.number().int().nonnegative(), url: z.string().url(),
      returnedCount: z.number().int().nonnegative(), cache: literatureCacheObservationSchema,
      coverage: literatureProviderCoverageSchema
    }).strict())
  }).strict()),
  truncated: z.boolean(), warnings: z.array(z.string()), total: z.number().int().nonnegative(), nextOffset: z.number().int().nullable(),
  planning: z.object({
    version: z.literal(1), domain: z.enum(['general', 'computing', 'biomedical', 'mixed']),
    sourceSelection: z.enum(['explicit', 'domain']), reasons: z.array(z.string()),
    dateInterpretation: z.literal('provider_native_with_local_year_check')
  }).strict().optional(),
  reranking: z.object({
    method: z.literal('lexical_diversity'), version: z.literal(1), candidateLimit: z.literal(100),
    scores: z.array(z.object({candidateId: z.string(), relevance: z.number(), diversityPenalty: z.number(), score: z.number()}).strict())
  }).strict().optional()
}).strict();
const page = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(30).default(10) };
export const literatureReadSearchSchema = z.object({ searchId: z.string().min(1), ...page, projectId: z.string().nullable().optional() }).strict();
const reason = z.string().trim().max(500).optional();
export const literatureAddSchema = z.object({
  entries: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('candidate'), searchId: z.string().min(1), candidateId: z.string().min(1), reason }).strict(),
    z.object({ kind: z.literal('doi'), doi: z.string().trim().min(1).max(512), reason }).strict(),
    z.object({kind: z.literal('zotero'), previewId: z.string().min(1), itemKey: zoteroItemKeySchema, reason}).strict()
  ])).min(1).max(30),
  destination: z.enum(['current_project', 'library_only']).default('current_project'), requestId: z.string().trim().min(1).max(200),
  projectId: z.string().min(1).nullable().optional(), ingestionPolicy: literatureIngestionPolicySchema.default('fulltext_auto'),
  topicTitle: z.string().trim().min(1).max(200).optional()
}).strict();
export const literatureGetImportToolSchema = z.object({ operationId: z.string().min(1).optional(), requestId: z.string().min(1).optional(),
  ...page
}).strict().refine((input) => (input.operationId === undefined) !== (input.requestId === undefined), 'literature_import_lookup_invalid');
export const literatureGetImportSchema = literatureGetImportToolSchema.safeExtend({ projectId: z.string().nullable().optional() });
export const literatureCancelImportSchema = z.object({ operationId: z.string().min(1), projectId: z.string().nullable().optional() }).strict();
export const literatureImportItemSchema = z.object({
  entryKey: z.string(), inputPositions: z.array(z.number().int()), libraryItemId: z.string().nullable(), citationKey: z.string().nullable(),
  disposition: z.enum(['created', 'linked', 'already_present', 'skipped_archived', 'failed', 'cancelled', 'not_processed']),
  metadataUpdated: z.boolean(), errorCode: z.string().nullable(), retryable: z.boolean(),
  citationKeyMapping: zoteroCitationKeyMappingSchema.optional(),
  metadata: z.enum(['ready', 'failed', 'not_requested']), attachment: z.literal('not_requested'), parse: z.literal('not_requested'),
  index: z.object({ scope: z.literal('metadata'), keyword: z.enum(['ready', 'pending', 'failed', 'not_requested']), vector: z.literal('not_requested') }).strict()
}).strict();
export const literatureImportResultSchema = z.object({
  operationId: z.string(), requestId: z.string(), status: z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled']),
  acquisitionBatchId: z.string().optional(), processingQueued: z.number().int().nonnegative().optional(), topicTitle: z.string().optional(),
  destinationProjectId: z.string().nullable(), requestedCount: z.number().int(), processedCount: z.number().int(),
  counts: z.object({ created: z.number().int(), linked: z.number().int(), alreadyPresent: z.number().int(), skippedArchived: z.number().int(),
    failed: z.number().int(), cancelled: z.number().int(), notProcessed: z.number().int() }).strict(),
  items: z.array(literatureImportItemSchema), nextOffset: z.number().int().nullable()
}).strict();
export const literatureLibraryChangedSchema = z.object({ eventId: z.string(), operationId: z.string().nullable(), affectedItemIds: z.array(z.string()),
  affectedProjectIds: z.array(z.string()), changeKind: z.enum(['import', 'link', 'archive', 'citation_key']), occurredAt: z.string() }).strict();
export type LiteratureLibraryChanged = z.infer<typeof literatureLibraryChangedSchema>;
export type LiteratureSearchInput = z.infer<typeof literatureSearchInputSchema>;
export type LiteraturePagePosition = z.infer<typeof literaturePagePositionSchema>;
export type LiteratureSearchResult = z.infer<typeof literatureSearchResultSchema>;
export type LiteratureCandidate = z.infer<typeof literatureCandidateSchema>;
export type LiteratureAdd = z.input<typeof literatureAddSchema>;
export type LiteratureImportResult = z.infer<typeof literatureImportResultSchema>;
export type LiteratureImportItem = z.infer<typeof literatureImportItemSchema>;
