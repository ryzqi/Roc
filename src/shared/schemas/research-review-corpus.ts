import {z} from 'zod';
import {literatureRankedRecordSchema} from './literature-search-pool';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const selectedSearch = z.object({reviewSearchId: id, expectedSnapshotHash: hash, expectedReceiptHash: hash}).strict();
export const researchReviewCorpusCreateSchema = z.object({
  projectId: id, requestId: id, versionId: id, expectedFreezeHash: hash,
  searches: z.array(selectedSearch).min(1).max(18)
}).strict().refine(value => new Set(value.searches.map(search => search.reviewSearchId)).size === value.searches.length,
  'review_corpus_duplicate_search');
export const researchReviewCorpusSourceSchema = z.object({
  reviewSearchId: id, snapshotHash: hash, receiptHash: hash, executionId: id.nullable(), poolHash: hash.nullable(),
  databaseIndex: z.number().int().min(0).max(5), queryIndex: z.number().int().min(0).max(2),
  status: z.enum(['complete', 'partial', 'failed', 'cancelled', 'interrupted']),
  rawRecordCount: z.number().int().nonnegative(), coverageComplete: z.boolean()
}).strict();
export const researchReviewCorpusHitSchema = z.object({
  id, reviewSearchId: id, recordIndex: z.number().int().nonnegative(), recordHash: hash
}).strict();
export const researchReviewCorpusSnapshotSchema = z.object({
  id, request: researchReviewCorpusCreateSchema, requestHash: hash, protocolVersionHash: hash,
  sources: z.array(researchReviewCorpusSourceSchema).min(1).max(18),
  hits: z.array(researchReviewCorpusHitSchema).max(1620), actor: researchRelationReviewerSchema, recordedAt: z.iso.datetime()
}).strict();
export const researchReviewCorpusInspectionSchema = z.object({
  snapshot: researchReviewCorpusSnapshotSchema, snapshotHash: hash,
  currentProtocol: z.boolean(), queryCount: z.number().int().positive(),
  identifiedRecords: z.number().int().nonnegative(), searchCoverageComplete: z.boolean()
}).strict();
export const researchReviewCorpusGetSchema = z.object({projectId: id, corpusId: id}).strict();
export const researchReviewCorpusListSchema = z.object({
  projectId: id, versionId: id, limit: z.number().int().min(1).max(100)
}).strict();
export const researchReviewCorpusHitRequestSchema = researchReviewCorpusGetSchema.extend({hitId: id});
export const researchReviewCorpusHitResultSchema = z.object({
  corpusId: id, corpusHash: hash, protocolVersionId: id, reference: researchReviewCorpusHitSchema,
  source: researchReviewCorpusSourceSchema, record: literatureRankedRecordSchema
}).strict();
export type ResearchReviewCorpusCreate = z.infer<typeof researchReviewCorpusCreateSchema>;
export type ResearchReviewCorpusInspection = z.infer<typeof researchReviewCorpusInspectionSchema>;
export type ResearchReviewCorpusHitResult = z.infer<typeof researchReviewCorpusHitResultSchema>;
