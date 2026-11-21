import {z} from 'zod';
import {researchIdeaPlanSaveSchema} from './research-idea-plans';
import {researchCitationReviewSaveSchema} from './research-citation-reviews';
import {researchConsistencySaveSchema} from './research-consistency';
import {researchFigureConsistencySaveSchema} from './research-figure-consistency';
import {researchResponseMatrixSaveSchema} from './research-response-matrix';
import {researchJournalSaveSchema, researchJournalSelectionSchema} from './research-journal-compliance';
import {researchExperimentResultReviewSchema} from './research-experiment-results';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchArgumentOutlineSaveSchema} from './research-argument-outline';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchProposalKindSchema = z.enum(['idea_plan', 'citation_review', 'consistency',
  'figure_consistency', 'response_matrix', 'journal_compliance', 'experiment_result', 'argument_outline']);

// Preserve each domain's field contracts; its whole-request refinements run below after scope is supplied.
export const researchProposalPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('argument_outline'), payload: z.strictObject(researchArgumentOutlineSaveSchema.shape).omit({projectId: true, requestId: true})}),
  z.strictObject({kind: z.literal('idea_plan'), payload: z.strictObject(researchIdeaPlanSaveSchema.shape).omit({projectId: true, requestId: true})}),
  z.strictObject({kind: z.literal('citation_review'), payload: z.strictObject(researchCitationReviewSaveSchema.shape).omit({projectId: true, requestId: true})}),
  z.strictObject({kind: z.literal('consistency'), payload: z.strictObject(researchConsistencySaveSchema.shape).omit({projectId: true, requestId: true})}),
  z.strictObject({kind: z.literal('figure_consistency'), payload: z.strictObject(researchFigureConsistencySaveSchema.shape).omit({projectId: true, requestId: true})}),
  z.strictObject({kind: z.literal('response_matrix'), payload: z.strictObject(researchResponseMatrixSaveSchema.shape).omit({projectId: true, requestId: true})}),
  z.strictObject({kind: z.literal('journal_compliance'), payload: researchJournalSaveSchema.omit({projectId: true, requestId: true})
    .extend({selection: researchJournalSelectionSchema.safeExtend({manualReviews: researchJournalSelectionSchema.shape.manualReviews.max(0)})})}),
  z.strictObject({kind: z.literal('experiment_result'), payload: z.strictObject(researchExperimentResultReviewSchema.shape).omit({projectId: true, requestId: true})})
]);
const domainSchemas = {
  argument_outline: researchArgumentOutlineSaveSchema,
  idea_plan: researchIdeaPlanSaveSchema, citation_review: researchCitationReviewSaveSchema,
  consistency: researchConsistencySaveSchema, figure_consistency: researchFigureConsistencySaveSchema,
  response_matrix: researchResponseMatrixSaveSchema, journal_compliance: researchJournalSaveSchema,
  experiment_result: researchExperimentResultReviewSchema
};
export const researchProposalCreateSchema = z.strictObject({
  projectId: id, requestId: id, artifactId: id, expectedArtifactVersion: hash,
  rationale: z.string().trim().min(1).max(12000),
  basis: z.strictObject({artifactId: id, expectedVersion: hash}).array().max(100),
  proposal: researchProposalPayloadSchema
}).superRefine((request, ctx) => {
  const parsed = domainSchemas[request.proposal.kind].safeParse({
    ...request.proposal.payload, projectId: request.projectId, requestId: request.requestId
  });
  if (!parsed.success) for (const issue of parsed.error.issues) {
    ctx.addIssue({code: 'custom', path: ['proposal', 'payload', ...issue.path], message: issue.message});
  }
  if (new Set(request.basis.map(item => item.artifactId)).size !== request.basis.length ||
      request.basis.some(item => item.artifactId === request.artifactId)) {
    ctx.addIssue({code: 'custom', path: ['basis'], message: 'research_proposal_duplicate_basis'});
  }
});
export const researchProposalGetSchema = z.strictObject({projectId: id, proposalId: id});
export const researchProposalListSchema = z.strictObject({
  projectId: id, artifactId: id.optional(), kind: researchProposalKindSchema.optional(), status: z.enum(['pending', 'rejected']).optional(),
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const researchProposalRejectSchema = researchProposalGetSchema.extend({
  expectedHash: hash, requestId: id, reason: z.string().trim().min(1).max(4000)
});
export const researchProposalOriginSchema = z.strictObject({
  kind: z.literal('chat'), runId: id, threadId: id, manifestHash: hash,
  operationId: id, idempotencyKey: id, toolCallId: id, toolName: id,
  canonicalToolIdentity: id, toolVersion: id
});
export const researchProposalSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), id, request: researchProposalCreateSchema, requestHash: hash,
  origin: researchProposalOriginSchema, materialHash: hash, recordedAt: z.string().datetime()
});
export const researchProposalRejectionSchema = z.strictObject({
  request: researchProposalRejectSchema, actor: researchRelationReviewerSchema, recordedAt: z.string().datetime()
});
export const researchProposalInspectionSchema = z.strictObject({
  snapshot: researchProposalSnapshotSchema, snapshotHash: hash,
  status: z.enum(['pending', 'rejected']), rejection: researchProposalRejectionSchema.nullable(),
  freshness: z.enum(['current', 'stale']),
  staleReasons: z.strictObject({artifactId: id, reason: z.string().min(1).max(300)}).array()
});
export const researchProposalListResultSchema = z.strictObject({
  items: researchProposalInspectionSchema.array(), total: z.number().int().nonnegative()
});
export type ResearchProposalCreate = z.infer<typeof researchProposalCreateSchema>;
export type ResearchProposalGet = z.infer<typeof researchProposalGetSchema>;
export type ResearchProposalList = z.infer<typeof researchProposalListSchema>;
export type ResearchProposalReject = z.infer<typeof researchProposalRejectSchema>;
export type ResearchProposalOrigin = z.infer<typeof researchProposalOriginSchema>;
export type ResearchProposalSnapshot = z.infer<typeof researchProposalSnapshotSchema>;
export type ResearchProposalInspection = z.infer<typeof researchProposalInspectionSchema>;
export type ResearchProposalListResult = z.infer<typeof researchProposalListResultSchema>;
