import { z } from 'zod';
import { researchLiteratureSchema } from './research';

export const literatureNetworkSourceSchema = z.enum(['openalex', 'crossref', 'semantic_scholar', 'arxiv', 'pubmed', 'europe_pmc']);
export const literatureSearchToolSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  sources: z.array(literatureNetworkSourceSchema).min(1).max(6).default(['openalex', 'crossref', 'arxiv']),
  limit: z.number().int().min(1).max(30).default(10),
  yearFrom: z.number().int().min(1000).max(9999).optional(),
  yearTo: z.number().int().min(1000).max(9999).optional()
}).strict().refine((input) => input.yearFrom === undefined || input.yearTo === undefined || input.yearFrom <= input.yearTo, 'literature_year_range_invalid');
export const literatureSearchInputSchema = literatureSearchToolSchema.safeExtend({ projectId: z.string().min(1).nullable().optional() });
export const literatureCandidateSchema = z.object({
  candidateId: z.string(), record: researchLiteratureSchema,
  origins: z.array(z.object({ source: literatureNetworkSourceSchema, externalId: z.string(), retrievedAt: z.string(), metadataHash: z.string() }).strict()),
  matchedLibraryItemId: z.string().nullable(), archived: z.boolean(), missingFields: z.array(z.string())
}).strict();
export const literatureSearchResultSchema = z.object({
  searchId: z.string(), createdAt: z.string(), expiresAt: z.string(), status: z.enum(['complete', 'partial', 'failed']),
  candidates: z.array(literatureCandidateSchema),
  sources: z.array(z.object({ source: literatureNetworkSourceSchema, status: z.enum(['ok', 'empty', 'timeout', 'rate_limited', 'error']),
    returnedCount: z.number().int().nonnegative(), errorCode: z.string().nullable(), retryAfterMs: z.number().nullable() }).strict()),
  truncated: z.boolean(), warnings: z.array(z.string()), total: z.number().int().nonnegative(), nextOffset: z.number().int().nullable()
}).strict();
const page = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(30).default(10) };
export const literatureReadSearchSchema = z.object({ searchId: z.string().min(1), ...page, projectId: z.string().nullable().optional() }).strict();
const reason = z.string().trim().max(500).optional();
export const literatureAddSchema = z.object({
  entries: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('candidate'), searchId: z.string().min(1), candidateId: z.string().min(1), reason }).strict(),
    z.object({ kind: z.literal('doi'), doi: z.string().trim().min(1).max(512), reason }).strict()
  ])).min(1).max(30),
  destination: z.enum(['current_project', 'library_only']).default('current_project'), requestId: z.string().trim().min(1).max(200),
  projectId: z.string().min(1).nullable().optional()
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
  metadata: z.enum(['ready', 'failed', 'not_requested']), attachment: z.literal('not_requested'), parse: z.literal('not_requested'),
  index: z.object({ scope: z.literal('metadata'), keyword: z.enum(['ready', 'pending', 'failed', 'not_requested']), vector: z.literal('not_requested') }).strict()
}).strict();
export const literatureImportResultSchema = z.object({
  operationId: z.string(), requestId: z.string(), status: z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled']),
  destinationProjectId: z.string().nullable(), requestedCount: z.number().int(), processedCount: z.number().int(),
  counts: z.object({ created: z.number().int(), linked: z.number().int(), alreadyPresent: z.number().int(), skippedArchived: z.number().int(),
    failed: z.number().int(), cancelled: z.number().int(), notProcessed: z.number().int() }).strict(),
  items: z.array(literatureImportItemSchema), nextOffset: z.number().int().nullable()
}).strict();
export const literatureLibraryChangedSchema = z.object({ eventId: z.string(), operationId: z.string().nullable(), affectedItemIds: z.array(z.string()),
  affectedProjectIds: z.array(z.string()), changeKind: z.enum(['import', 'link', 'archive', 'citation_key']), occurredAt: z.string() }).strict();
export type LiteratureLibraryChanged = z.infer<typeof literatureLibraryChangedSchema>;
export type LiteratureSearchInput = z.infer<typeof literatureSearchInputSchema>;
export type LiteratureSearchResult = z.infer<typeof literatureSearchResultSchema>;
export type LiteratureCandidate = z.infer<typeof literatureCandidateSchema>;
export type LiteratureAdd = z.infer<typeof literatureAddSchema>;
export type LiteratureImportResult = z.infer<typeof literatureImportResultSchema>;
export type LiteratureImportItem = z.infer<typeof literatureImportItemSchema>;
