import {z} from 'zod';
import {researchExperimentMetricDefinitionSchema} from './research-experiment-results';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(4000);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIds = z.array(id).max(100).refine(ids => new Set(ids).size === ids.length,
  'research_idea_plan_duplicate_evidence');
const canvas = z.strictObject({version: z.number().int().positive(), contentHash: hash});

export const researchIdeaPlanBodySchema = z.strictObject({
  hypothesis: text,
  falsifiableIf: text,
  metrics: z.array(researchExperimentMetricDefinitionSchema.extend({expectedOutcome: text})).min(1).max(100),
  dataPlan: text,
  design: text,
  analysisPlan: text,
  observation: z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('before_data')}),
    z.strictObject({kind: z.literal('after_data'), evidenceIds: evidenceIds.refine(ids => ids.length > 0)})
  ]),
  novelty: z.strictObject({
    status: z.literal('pending_verification'),
    searchScope: text,
    comparisons: z.array(z.strictObject({evidenceId: id, similarities: text, differences: text})).max(100)
  }),
  sampleSize: z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('not_calculated'), reason: text}),
    z.strictObject({
      kind: z.literal('calculated'), method: text,
      parameters: z.record(id, text).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 100),
      value: z.number().int().positive(), evidenceIds, reviewNote: text
    })
  ])
}).refine(body => new Set(body.metrics.map(metric => metric.id)).size === body.metrics.length,
  'research_idea_plan_duplicate_metric');

export const researchIdeaPlanSaveSchema = z.strictObject({
  projectId: id, artifactId: id, requestId: id, canvas,
  parent: z.strictObject({versionId: id, versionHash: hash}).nullable(),
  revisionReason: text.nullable(), body: researchIdeaPlanBodySchema
}).refine(request => (request.parent === null) === (request.revisionReason === null),
  'research_idea_plan_revision_reason_required');
export const researchIdeaPlanGetSchema = z.strictObject({projectId: id, artifactId: id, versionId: id, expectedHash: hash});
export const researchIdeaPlanHistorySchema = z.strictObject({
  projectId: id, artifactId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const researchIdeaPlanFreezeRequestSchema = researchIdeaPlanGetSchema.extend({requestId: id, reviewNote: text});
export const researchIdeaPlanVersionSchema = z.strictObject({
  schemaVersion: z.literal(1), id, version: z.number().int().positive(),
  request: researchIdeaPlanSaveSchema, requestHash: hash, actor: researchRelationReviewerSchema, recordedAt: text
});
export const researchIdeaPlanFreezeSchema = z.strictObject({
  request: researchIdeaPlanFreezeRequestSchema, requestHash: hash, actor: researchRelationReviewerSchema, frozenAt: text
});
export const researchIdeaPlanInspectionSchema = z.strictObject({
  version: researchIdeaPlanVersionSchema, versionHash: hash,
  freeze: researchIdeaPlanFreezeSchema.nullable(), freezeHash: hash.nullable(),
  isLatest: z.boolean(), canvasCurrent: z.boolean()
});
export const researchIdeaPlanHistoryResultSchema = z.strictObject({
  items: researchIdeaPlanInspectionSchema.array(), total: z.number().int().nonnegative()
});

export type ResearchIdeaPlanBody = z.infer<typeof researchIdeaPlanBodySchema>;
export type ResearchIdeaPlanSave = z.infer<typeof researchIdeaPlanSaveSchema>;
export type ResearchIdeaPlanGet = z.infer<typeof researchIdeaPlanGetSchema>;
export type ResearchIdeaPlanHistory = z.infer<typeof researchIdeaPlanHistorySchema>;
export type ResearchIdeaPlanFreezeRequest = z.infer<typeof researchIdeaPlanFreezeRequestSchema>;
export type ResearchIdeaPlanInspection = z.infer<typeof researchIdeaPlanInspectionSchema>;
export type ResearchIdeaPlanHistoryResult = z.infer<typeof researchIdeaPlanHistoryResultSchema>;
