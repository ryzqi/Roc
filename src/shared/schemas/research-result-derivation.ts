import {z} from 'zod';
import {
  researchExperimentCompareSchema, researchExperimentComparisonSchema, researchExperimentMetricDefinitionSchema,
  researchExperimentMetricSchema, researchExperimentResultEvidenceMetadataSchema, researchExperimentResultGetSchema,
  researchExperimentResultSnapshotSchema
} from './research-experiment-results';
import {researchConsistencyBindingSchema} from './research-consistency';
import {researchResponseRowSchema} from './research-response-matrix';
import {researchArtifactInspectRequestSchema} from './research-artifact-inspector';
import {researchExperimentPathSchema} from './research-experiments';

const hash = researchExperimentResultGetSchema.shape.expectedHash;
const metricId = researchExperimentMetricSchema.shape.id;
const result = researchExperimentCompareSchema.shape.left;
const manuscript = researchArtifactInspectRequestSchema.omit({projectId: true}).extend({expectedVersion: hash});
const uniqueMetricIds = metricId.array().min(1).max(100).refine(ids => new Set(ids).size === ids.length);

export const researchResultDerivationRequestSchema = researchExperimentResultGetSchema.extend({
  metricIds: uniqueMetricIds.optional(), previous: result.optional(), manuscript: manuscript.optional(),
  commentId: researchResponseRowSchema.shape.commentId.optional()
}).refine(request => request.commentId === undefined || request.manuscript !== undefined, 'research_result_derivation_manuscript_required');

export const researchResultDerivationSchema = z.strictObject({
  result,
  previous: result.extend({differences: researchExperimentComparisonSchema.shape.differences}).nullable(),
  execution: researchExperimentResultSnapshotSchema.shape.execution,
  methods: z.string().min(1),
  rows: z.strictObject({
    ordinal: z.number().int().nonnegative(), metric: researchExperimentMetricSchema, definition: researchExperimentMetricDefinitionSchema,
    source: researchExperimentResultEvidenceMetadataSchema, evidenceId: z.string().min(1).nullable()
  }).array().min(1).max(100),
  figures: z.strictObject({unit: researchExperimentMetricSchema.shape.unit, filename: researchExperimentPathSchema,
    source: z.string().min(1), sourceHash: hash, metricIds: uniqueMetricIds}).array().min(1).max(100),
  manuscript: manuscript.extend({
    changes: z.strictObject({
      binding: researchConsistencyBindingSchema, before: z.string().min(1), after: z.string().min(1),
      result, evidenceId: z.string().min(1).nullable()
    }).array().max(200),
    paragraphs: z.strictObject({
      claimId: researchConsistencyBindingSchema.shape.claimId, expectedClaimHash: hash,
      before: z.string().min(1), after: z.string().min(1),
      replacement: z.strictObject({latex: z.string().min(1), evidenceIds: z.string().min(1).array().min(1),
        citationKeys: z.string().min(1).array().min(1)}).nullable()
    }).array().max(200),
    bibliography: z.string(),
    issues: z.strictObject({metricId, claimId: researchConsistencyBindingSchema.shape.claimId,
      reason: z.enum(['location_changed', 'definition_changed', 'source_changed', 'unrepresentable_value'])}).array().max(200)
  }).nullable(),
  responseDraft: z.strictObject({reviewId: z.string().min(1), reviewHash: hash, row: researchResponseRowSchema}).nullable()
});

export type ResearchResultDerivationRequest = z.infer<typeof researchResultDerivationRequestSchema>;
export type ResearchResultDerivation = z.infer<typeof researchResultDerivationSchema>;
