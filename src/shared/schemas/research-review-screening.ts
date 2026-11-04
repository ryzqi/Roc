import {z} from 'zod';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
/** Declared researcher identity is provenance; main-process caller identity grants write authority. */
export const researchReviewScreeningReviewerSchema = z.object({id, name: id}).strict();
export const researchReviewScreeningPlanCreateSchema = z.object({
  projectId: id, corpusId: id, requestId: id, expectedCorpusHash: hash, expectedDedupFreezeHash: hash,
  titleAbstractReviewers: z.array(researchReviewScreeningReviewerSchema).min(1).max(2),
  fullTextReviewers: z.array(researchReviewScreeningReviewerSchema).min(1).max(2),
  adjudicator: researchReviewScreeningReviewerSchema,
  reviewNote: z.string().trim().min(1).max(10000)
}).strict().superRefine((request, context) => {
  for (const reviewers of [request.titleAbstractReviewers, request.fullTextReviewers]) {
    if (new Set(reviewers.map(reviewer => reviewer.id)).size !== reviewers.length) {
      context.addIssue({code: 'custom', message: 'review_screening_reviewers_duplicate'});
    }
  }
  const identities = new Map<string, string>();
  for (const reviewer of [...request.titleAbstractReviewers, ...request.fullTextReviewers, request.adjudicator]) {
    if (identities.has(reviewer.id) && identities.get(reviewer.id) !== reviewer.name) {
      context.addIssue({code: 'custom', message: 'review_screening_reviewer_name_conflict'});
    }
    identities.set(reviewer.id, reviewer.name);
  }
});
export const researchReviewScreeningPlanGetSchema = z.object({projectId: id, corpusId: id}).strict();
export const researchReviewScreeningPlanSnapshotSchema = z.object({
  id, request: researchReviewScreeningPlanCreateSchema, requestHash: hash,
  protocolVersionId: id, protocolVersionHash: hash,
  actor: researchRelationReviewerSchema, recordedAt: z.iso.datetime()
}).strict();
export const researchReviewScreeningPlanInspectionSchema = z.object({
  snapshot: researchReviewScreeningPlanSnapshotSchema, snapshotHash: hash, currentProtocol: z.boolean()
}).strict();
export type ResearchReviewScreeningPlanCreate = z.infer<typeof researchReviewScreeningPlanCreateSchema>;
export type ResearchReviewScreeningPlanInspection = z.infer<typeof researchReviewScreeningPlanInspectionSchema>;
