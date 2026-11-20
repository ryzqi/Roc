import {z} from 'zod';
import {researchExportFileSchema} from './research-export-file';
import {researchExportPublicationReviewSchema} from './research-export-publication';
import {scientificReviewInspectionSchema} from './research-scientific-review';
import {researchSkillPinSchema} from './research-skills';

const id = z.string().min(1);
const hash = researchExportFileSchema.shape.sha256;
export const exportValidationVersion = 'roc-export-validation/v1';
export const exportValidationPath = 'provenance/validation.json';

/** Private source contract; the bundle contains its explicit public projection. */
export const researchExportValidationSchema = z.strictObject({
  schemaVersion: z.literal(1), rulesVersion: z.literal(exportValidationVersion),
  scientificRulesVersion: id, projectId: id, sourceHash: hash,
  manuscript: z.strictObject({artifactId: id, artifactHash: hash, hash}),
  deterministicChecks: z.strictObject({
    sourceClosure: z.literal('validated'), humanSupport: z.literal('validated'),
    publicationSelection: z.literal('validated'), compiledOutputs: z.array(researchExportFileSchema).length(2)
  }),
  humanReviewFile: researchExportFileSchema,
  semanticAuthority: z.literal('model_suggestion_requires_human_review'),
  semanticReports: z.array(scientificReviewInspectionSchema),
  claims: z.array(z.strictObject({
    claimId: id, version: z.number().int().positive(), hash,
    adviceStatus: z.enum(['missing_current_verifier', 'requires_human_review']),
    currentVerifierReportIds: z.array(id), humanConfirmedRelationIds: z.array(id)
  })),
  runs: z.array(z.strictObject({
    runId: id, taskId: id.nullable(), role: id, providerId: id.nullable(), modelId: id.nullable(),
    modelVersion: id.nullable(), skillHash: hash, skillPin: researchSkillPinSchema
  })),
  experiments: z.array(z.strictObject({
    runId: id, artifactId: id.nullable(), inputHash: hash, environmentHash: hash,
    files: z.array(z.strictObject({...researchExportFileSchema.shape, area: z.enum(['input', 'output', 'log'])})),
    materialAvailability: z.enum(['all_selected_originals_bundled', 'external_material_required']),
    replay: z.literal('not_run'), scientificReplication: z.literal('not_verified')
  })),
  publicationReview: researchExportPublicationReviewSchema,
  referenceDelivery: z.literal('metadata_only'), journalSupplementDelivery: z.literal('metadata_only'),
  externalPublication: z.literal('not_performed_by_export')
});
export type ResearchExportValidation = z.infer<typeof researchExportValidationSchema>;
