import {z} from 'zod';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchReviewCorpusHitSchema, researchReviewCorpusSourceSchema} from './research-review-corpus';

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

const note = z.string().trim().min(1).max(10000);
const includeOutcome = z.object({decision: z.literal('include'), inclusionCriterionIds: z.array(id).min(1).max(50), reason: note}).strict()
  .refine(value => new Set(value.inclusionCriterionIds).size === value.inclusionCriterionIds.length, 'review_screening_criteria_duplicate');
const excludeOutcome = z.object({decision: z.literal('exclude'), exclusionCriterionId: id, reason: note}).strict();
export const researchReviewScreeningFinalOutcomeSchema = z.discriminatedUnion('decision', [includeOutcome, excludeOutcome]);
export const researchReviewScreeningOutcomeSchema = z.discriminatedUnion('decision', [
  includeOutcome, excludeOutcome,
  z.object({decision: z.literal('uncertain'), reason: note}).strict()
]);
const reference = z.object({id, expectedHash: hash}).strict();
const screeningTarget = researchReviewScreeningPlanGetSchema.extend({
  expectedPlanHash: hash, hitId: id, phase: z.literal('title_abstract'), requestId: id
});
export const researchReviewScreeningDecisionSaveSchema = screeningTarget.extend({
  reviewerId: id, outcome: researchReviewScreeningOutcomeSchema, consideredSuggestion: reference.nullable(),
  parentDecisionId: id.nullable(), expectedParentHash: hash.nullable(), revisionReason: note.nullable()
}).refine(value => value.parentDecisionId === null ?
  value.expectedParentHash === null && value.revisionReason === null :
  value.expectedParentHash !== null && value.revisionReason !== null, 'review_screening_revision_requires_parent');
export const researchReviewScreeningSuggestionCreateSchema = screeningTarget.extend({outcome: researchReviewScreeningOutcomeSchema});
export const researchReviewScreeningSuggestionOriginSchema = z.object({
  kind: z.literal('agent_tool'), operationId: id, idempotencyKey: id, toolCallId: id,
  canonicalToolIdentity: id, toolVersion: id, attemptId: id,
  capabilityName: z.literal('research.reviewScreening.suggest'), capabilityVersion: id
}).strict();
const material = z.object({
  hit: researchReviewCorpusHitSchema, source: researchReviewCorpusSourceSchema,
  abstractStatus: z.enum(['present', 'missing'])
}).strict();
export const researchReviewScreeningDecisionSnapshotSchema = z.object({
  id, version: z.number().int().positive(), request: researchReviewScreeningDecisionSaveSchema, requestHash: hash,
  reviewer: researchReviewScreeningReviewerSchema, material,
  actor: researchRelationReviewerSchema, recordedAt: z.iso.datetime()
}).strict();
export const researchReviewScreeningDecisionInspectionSchema = z.object({
  snapshot: researchReviewScreeningDecisionSnapshotSchema, snapshotHash: hash, isLatest: z.boolean()
}).strict();
export const researchReviewScreeningSuggestionSnapshotSchema = z.object({
  id, request: researchReviewScreeningSuggestionCreateSchema, requestHash: hash,
  material, origin: researchReviewScreeningSuggestionOriginSchema, recordedAt: z.iso.datetime()
}).strict();
export const researchReviewScreeningSuggestionInspectionSchema = z.object({
  snapshot: researchReviewScreeningSuggestionSnapshotSchema, snapshotHash: hash
}).strict();
export const researchReviewScreeningDecisionHistorySchema = researchReviewScreeningPlanGetSchema.extend({decisionId: id});
export const researchReviewScreeningSuggestionListSchema = researchReviewScreeningPlanGetSchema.extend({
  phase: z.literal('title_abstract'), hitId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(30)
});
export const researchReviewScreeningPhaseGetSchema = researchReviewScreeningPlanGetSchema.extend({phase: z.literal('title_abstract')});
export const researchReviewScreeningPhaseInspectionSchema = z.object({
  plan: researchReviewScreeningPlanInspectionSchema, phase: z.literal('title_abstract'),
  items: z.array(z.object({
    hit: researchReviewCorpusHitSchema, decisions: z.array(researchReviewScreeningDecisionInspectionSchema).max(2),
    status: z.enum(['pending', 'uncertain', 'conflict', 'included', 'excluded']),
    suggestionCount: z.number().int().nonnegative()
  }).strict()),
  counts: z.object({
    recordsToScreen: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(), conflict: z.number().int().nonnegative(),
    included: z.number().int().nonnegative(), excluded: z.number().int().nonnegative()
  }).strict()
}).strict().refine(value => value.counts.recordsToScreen === value.items.length &&
  value.counts.recordsToScreen === value.counts.pending + value.counts.uncertain + value.counts.conflict +
  value.counts.included + value.counts.excluded, 'review_screening_counts_not_conserved');
export type ResearchReviewScreeningDecisionSave = z.infer<typeof researchReviewScreeningDecisionSaveSchema>;
export type ResearchReviewScreeningDecisionInspection = z.infer<typeof researchReviewScreeningDecisionInspectionSchema>;
export type ResearchReviewScreeningSuggestionCreate = z.infer<typeof researchReviewScreeningSuggestionCreateSchema>;
export type ResearchReviewScreeningSuggestionOrigin = z.infer<typeof researchReviewScreeningSuggestionOriginSchema>;
export type ResearchReviewScreeningSuggestionInspection = z.infer<typeof researchReviewScreeningSuggestionInspectionSchema>;
export type ResearchReviewScreeningPhaseInspection = z.infer<typeof researchReviewScreeningPhaseInspectionSchema>;

export const researchReviewScreeningArbitrationSaveSchema = screeningTarget.extend({
  reviewerId: id, outcome: researchReviewScreeningFinalOutcomeSchema,
  decisions: z.array(reference).min(1).max(2),
  parentArbitrationId: id.nullable(), expectedParentHash: hash.nullable(), revisionReason: note.nullable()
}).refine(value => new Set(value.decisions.map(decision => decision.id)).size === value.decisions.length,
  'review_screening_arbitration_decision_duplicate')
  .refine(value => value.parentArbitrationId === null ?
    value.expectedParentHash === null && value.revisionReason === null :
    value.expectedParentHash !== null && value.revisionReason !== null, 'review_screening_arbitration_revision_requires_parent');
export const researchReviewScreeningArbitrationSnapshotSchema = z.object({
  id, version: z.number().int().positive(), request: researchReviewScreeningArbitrationSaveSchema, requestHash: hash,
  adjudicator: researchReviewScreeningReviewerSchema, material,
  actor: researchRelationReviewerSchema, recordedAt: z.iso.datetime()
}).strict();
export const researchReviewScreeningArbitrationInspectionSchema = z.object({
  snapshot: researchReviewScreeningArbitrationSnapshotSchema, snapshotHash: hash,
  isLatest: z.boolean(), currentDecisionSet: z.boolean()
}).strict();
export const researchReviewScreeningArbitrationHistorySchema = researchReviewScreeningPlanGetSchema.extend({arbitrationId: id});
export const researchReviewScreeningResolvedPhaseSchema = researchReviewScreeningPhaseInspectionSchema.safeExtend({
  items: z.array(researchReviewScreeningPhaseInspectionSchema.shape.items.element.extend({
    arbitration: researchReviewScreeningArbitrationInspectionSchema.nullable()
  }))
});
export type ResearchReviewScreeningArbitrationSave = z.infer<typeof researchReviewScreeningArbitrationSaveSchema>;
export type ResearchReviewScreeningArbitrationInspection = z.infer<typeof researchReviewScreeningArbitrationInspectionSchema>;
export type ResearchReviewScreeningResolvedPhase = z.infer<typeof researchReviewScreeningResolvedPhaseSchema>;
