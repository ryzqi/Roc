import {z} from 'zod';
import {researchIdeaPlanVersionSchema, researchIdeaPlanFreezeSchema} from './research-idea-plans';
import {researchExperimentResultReceiptSchema} from './research-experiment-results';
import {researchEvidenceSchema} from './research-evidence';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(4000);
const mapping = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('measured'), plannedMetricId: id, evidenceId: id}),
  z.strictObject({kind: z.literal('missing'), plannedMetricId: id, reason: text})
]);
export const researchIdeaOutcomeSaveSchema = z.strictObject({
  projectId: id, artifactId: id, requestId: id,
  plan: z.strictObject({versionId: id, versionHash: hash, freezeHash: hash}),
  result: z.strictObject({resultId: id, expectedHash: hash}),
  metrics: mapping.array().min(1).max(100),
  verdict: z.enum(['supports', 'contradicts', 'inconclusive', 'not_comparable']),
  reviewNote: text,
  parent: z.strictObject({outcomeId: id, outcomeHash: hash}).nullable(),
  revisionReason: text.nullable()
}).superRefine((request, context) => {
  const measured = request.metrics.filter(metric => metric.kind === 'measured');
  if (new Set(request.metrics.map(metric => metric.plannedMetricId)).size !== request.metrics.length ||
    new Set(measured.map(metric => metric.evidenceId)).size !== measured.length || measured.length === 0) {
    context.addIssue({code: 'custom', message: 'research_idea_outcome_metric_mapping_invalid'});
  }
  if ((request.parent === null) !== (request.revisionReason === null)) {
    context.addIssue({code: 'custom', message: 'research_idea_outcome_revision_reason_required'});
  }
});
export const researchIdeaOutcomeGetSchema = z.strictObject({
  projectId: id, artifactId: id, outcomeId: id, expectedHash: hash
});
export const researchIdeaOutcomeHistorySchema = z.strictObject({
  projectId: id, artifactId: id, versionId: id, offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100)
});
export const researchIdeaOutcomeMaterialSchema = z.strictObject({
  plan: z.strictObject({
    version: researchIdeaPlanVersionSchema, versionHash: hash,
    freeze: researchIdeaPlanFreezeSchema, freezeHash: hash
  }),
  result: researchExperimentResultReceiptSchema,
  executionTime: z.strictObject({startedAt: z.iso.datetime(), endedAt: z.iso.datetime()}),
  evidence: researchEvidenceSchema.array().min(1).max(100),
  differences: z.strictObject({
    plannedMetricId: id, fields: z.enum(['missing_metric', 'definition', 'unit', 'direction']).array().min(1).max(4)
  }).array().max(100)
});
export const researchIdeaOutcomeSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), id, version: z.number().int().positive(),
  request: researchIdeaOutcomeSaveSchema, requestHash: hash, actor: researchRelationReviewerSchema,
  recordedAt: text, material: researchIdeaOutcomeMaterialSchema
});
export const researchIdeaOutcomeReceiptSchema = z.strictObject({
  snapshot: researchIdeaOutcomeSnapshotSchema, snapshotHash: hash
});
export const researchIdeaOutcomeHistoryResultSchema = z.strictObject({
  verification: z.literal('stored_receipt'), items: researchIdeaOutcomeReceiptSchema.array(),
  total: z.number().int().nonnegative()
});
export const researchIdeaOutcomeHeadSchema = z.strictObject({
  outcomeId: id, outcomeHash: hash, version: z.number().int().positive(), planVersionId: id,
  resultId: id, verdict: researchIdeaOutcomeSaveSchema.shape.verdict, recordedAt: text,
  evidenceIds: id.array().min(1).max(100)
});
export type ResearchIdeaOutcomeSave = z.infer<typeof researchIdeaOutcomeSaveSchema>;
export type ResearchIdeaOutcomeGet = z.infer<typeof researchIdeaOutcomeGetSchema>;
export type ResearchIdeaOutcomeHistory = z.infer<typeof researchIdeaOutcomeHistorySchema>;
export type ResearchIdeaOutcomeMaterial = z.infer<typeof researchIdeaOutcomeMaterialSchema>;
export type ResearchIdeaOutcomeReceipt = z.infer<typeof researchIdeaOutcomeReceiptSchema>;
export type ResearchIdeaOutcomeHistoryResult = z.infer<typeof researchIdeaOutcomeHistoryResultSchema>;
export type ResearchIdeaOutcomeHead = z.infer<typeof researchIdeaOutcomeHeadSchema>;
