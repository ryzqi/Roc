import {z} from 'zod';
import {literatureSearchInputSchema, literatureSearchResultSchema} from './literature-import';
import {literatureSearchPoolPageSchema} from './literature-search-pool';
import {researchRelationActorSchema} from './research-evidence-relations';
import {researchTaskExecutionSchema} from './research-tasks';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchReviewSearchStartSchema = z.object({
  projectId: id, requestId: id, versionId: id, expectedFreezeHash: hash,
  databaseIndex: z.number().int().min(0).max(5), queryIndex: z.number().int().min(0).max(2),
  retryOf: id.nullable(), expectedRetrySnapshotHash: hash.nullable()
}).strict().refine(value => (value.retryOf === null) === (value.expectedRetrySnapshotHash === null), 'review_retry_snapshot_required');
export const researchReviewSearchSnapshotSchema = z.object({
  id, request: researchReviewSearchStartSchema, requestHash: hash, protocolVersionHash: hash,
  parameters: literatureSearchInputSchema, actor: researchRelationActorSchema, startedAt: z.iso.datetime()
}).strict();
export const researchReviewSearchStatusSchema = z.enum(['running', 'cancelling', 'complete', 'partial', 'failed', 'cancelled', 'interrupted']);
export const researchReviewSearchReceiptSchema = z.object({
  reviewSearchId: id, status: z.enum(['complete', 'partial', 'failed', 'cancelled', 'interrupted']),
  executionId: id.nullable(), poolHash: hash.nullable(), errorCode: id.nullable(), endedAt: z.iso.datetime()
}).strict().refine(value => value.poolHash === null || value.executionId !== null, 'review_search_pool_requires_execution');
export const researchReviewSearchGetSchema = z.object({projectId: id, reviewSearchId: id}).strict();
export const researchReviewSearchCancelSchema = researchReviewSearchGetSchema.extend({
  requestId: id, expectedRevision: z.number().int().positive(), note: z.string().trim().min(1).max(10000)
});
export const researchReviewSearchCancelReceiptSchema = z.object({
  request: researchReviewSearchCancelSchema, requestHash: hash, actor: researchRelationActorSchema, recordedAt: z.iso.datetime()
}).strict();
export const researchReviewSearchInspectionSchema = z.object({
  snapshot: researchReviewSearchSnapshotSchema, snapshotHash: hash, status: researchReviewSearchStatusSchema,
  revision: z.number().int().positive(), receipt: researchReviewSearchReceiptSchema.nullable(), receiptHash: hash.nullable(),
  cancellation: researchReviewSearchCancelReceiptSchema.nullable(), cancellationHash: hash.nullable(),
  sources: literatureSearchResultSchema.shape.sources, rawRecordCount: z.number().int().nonnegative(),
  coverageComplete: z.boolean()
}).strict().refine(value => (value.status === 'running' || value.status === 'cancelling') ?
  value.receipt === null && value.receiptHash === null :
  value.receipt !== null && value.receiptHash !== null && value.receipt.status === value.status,
  'review_search_terminal_receipt_required')
  .refine(value => (value.status === 'complete') === value.coverageComplete, 'review_search_complete_requires_coverage')
  .refine(value => (value.cancellation === null) === (value.cancellationHash === null) &&
    (value.status !== 'cancelling' || value.cancellation !== null), 'review_search_cancellation_receipt_required');
export const researchReviewSearchListSchema = z.object({
  projectId: id, versionId: id, limit: z.number().int().min(1).max(100)
}).strict();
export const researchReviewSearchPoolRequestSchema = researchReviewSearchGetSchema.extend({
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(30)
});
export const researchReviewSearchPoolResultSchema = z.object({
  reviewSearch: researchReviewSearchInspectionSchema, pool: literatureSearchPoolPageSchema
}).strict();
export const researchReviewSearchOwnershipSchema = z.object({
  grantId: id, runId: id, threadId: id, projectId: id, requestHash: hash, manifestHash: hash
}).strict();
export const researchReviewOwnedSearchInspectionSchema = z.object({
  search: researchReviewSearchInspectionSchema, association: researchTaskExecutionSchema
}).strict();
export type ResearchReviewSearchStart = z.infer<typeof researchReviewSearchStartSchema>;
export type ResearchReviewSearchInspection = z.infer<typeof researchReviewSearchInspectionSchema>;
export type ResearchReviewSearchSnapshot = z.infer<typeof researchReviewSearchSnapshotSchema>;
export type ResearchReviewSearchReceipt = z.infer<typeof researchReviewSearchReceiptSchema>;
export type ResearchReviewSearchCancel = z.infer<typeof researchReviewSearchCancelSchema>;
export type ResearchReviewSearchPoolResult = z.infer<typeof researchReviewSearchPoolResultSchema>;
export type ResearchReviewSearchOwnership = z.infer<typeof researchReviewSearchOwnershipSchema>;
export type ResearchReviewOwnedSearchInspection = z.infer<typeof researchReviewOwnedSearchInspectionSchema>;
