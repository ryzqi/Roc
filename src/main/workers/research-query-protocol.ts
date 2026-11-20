import { z } from 'zod';
import { researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema } from '../../shared/schemas/research';
import type { ResearchKnowledgeSearchResult } from '../../shared/types';
import type { ResearchKnowledgeRepository } from '../plugins/research/knowledge-repository';

export type ResearchQueryInput = Parameters<ResearchKnowledgeRepository['searchKnowledge']>[0];

export const researchQueryLimits = Object.freeze({
  pending: 8,
  requestBytes: 1024 * 1024,
  queuedBytes: 4 * 1024 * 1024,
  resultBytes: 8 * 1024 * 1024,
  deadlineMs: 30_000,
  idleMs: 30_000,
  thresholdChunks: 10_000,
  cacheKiB: 16 * 1024
});

export const researchQueryDatabaseSchema = z.object({
  path: z.string().min(1),
  device: z.string(),
  inode: z.string(),
  schema: z.number().int().nonnegative()
}).strict();
export type ResearchQueryDatabase = z.infer<typeof researchQueryDatabaseSchema>;

const requestId = z.string().uuid();
const bytes = z.instanceof(Uint8Array);
const deadline = z.number().int().positive();
const snapshot = z.object({ dataVersion: z.number().int(), schema: z.number().int() }).strict();

export const researchQueryWireSchema = z.object({
  protocol: z.literal(1), type: z.literal('search'), requestId, deadline,
  bytes: bytes.refine(value => value.byteLength <= researchQueryLimits.requestBytes)
}).strict();
export type ResearchQueryWire = z.infer<typeof researchQueryWireSchema>;

export const researchQueryRequestSchema = z.object({
  capability: z.literal('research.knowledge.search'),
  scope: z.string().min(1).nullable(),
  generatedAt: z.string(),
  input: z.object({
    request: researchKnowledgeSearchRequestSchema,
    vector: z.object({
      configId: z.string().min(1), configRevision: z.number().int().positive(),
      blob: bytes.refine(value => value.byteLength <= researchQueryLimits.requestBytes)
    }).strict().nullable(),
    degradation: z.enum(['timeout', 'network', 'rate_limit', 'provider_unavailable']).optional()
  }).strict()
}).strict().refine(value => value.scope === value.input.request.projectId);
export type ResearchQueryRequest = z.infer<typeof researchQueryRequestSchema>;

export const researchQueryReplySchema = z.discriminatedUnion('type', [
  z.object({ protocol: z.literal(1), type: z.literal('ready'), database: researchQueryDatabaseSchema }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('init-error'), code: z.string().min(1).max(256) }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('started'), requestId }).strict(),
  z.object({
    protocol: z.literal(1), type: z.literal('result'), requestId,
    bytes: bytes.refine(value => value.byteLength <= researchQueryLimits.resultBytes),
    snapshot, queryMs: z.number().nonnegative()
  }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('fallback'), requestId, reason: z.literal('result_bytes') }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('error'), requestId, code: z.string().min(1).max(256) }).strict()
]);
export type ResearchQueryReply = z.infer<typeof researchQueryReplySchema>;

/** Reject obviously large messages before allocating a second serialized copy. */
export function fitsResearchQueryBudget(value: unknown, limit: number): boolean {
  let size = 0;
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    size += 16;
    if (typeof item === 'string') size += Buffer.byteLength(item);
    else if (item instanceof Uint8Array) size += item.byteLength;
    else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        size += Buffer.byteLength(key);
        pending.push(child);
      }
    }
    if (size > limit) return false;
  }
  return true;
}

/** Validation must preserve the JSON field order bound into ranking.inputHash. */
export function validateResearchQueryResult(value: unknown, input: ResearchQueryInput): asserts value is ResearchKnowledgeSearchResult {
  researchKnowledgeSearchResultSchema.parse(value);
  const result = value as ResearchKnowledgeSearchResult;
  const limit = input.request.candidateLimit ?? Math.min(200, Math.max(50, input.request.limit * 4));
  if (result.query !== input.request.query || result.ranking.projectId !== input.request.projectId ||
      result.ranking.limit !== input.request.limit || result.ranking.candidateLimit !== limit ||
      result.hits.length > input.request.limit || result.ranking.candidates.length > limit * 2 ||
      result.keywordCount < 0 || result.keywordCount > limit || result.vectorCount < 0 || result.vectorCount > limit ||
      (input.vector === null ? result.ranking.embedding !== null :
        result.ranking.embedding?.configId !== input.vector.configId ||
        result.ranking.embedding.revision !== input.vector.configRevision)) {
    throw new Error('research_query_result_binding_invalid');
  }
}
