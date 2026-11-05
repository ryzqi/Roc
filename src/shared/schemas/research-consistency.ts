import {z} from 'zod';
import {researchClaimSchema, researchEvidenceSchema} from './research-evidence';
import {researchExperimentResultReceiptSchema} from './research-experiment-results';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const note = z.string().trim().min(1).max(4000);
export const researchConsistencyRuleSchema = z.strictObject({
  conversion: z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('identity')}),
    z.strictObject({kind: z.literal('affine'), fromUnit: id, toUnit: id,
      scale: z.number().refine(value => value !== 0), offset: z.number(), rationale: note})
  ]),
  rounding: z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('none')}),
    z.strictObject({kind: z.literal('decimal_places'), places: z.number().int().min(0).max(12),
      mode: z.literal('half_away_from_zero')})
  ]),
  tolerance: z.strictObject({absolute: z.number().nonnegative(), relative: z.number().nonnegative(), rationale: note})
});
export const researchConsistencyBindingSchema = z.strictObject({
  claimId: id, expectedClaimHash: hash,
  surface: z.enum(['abstract', 'body', 'table', 'figure_caption']),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  unit: id, evidenceId: id, resultId: id, resultHash: hash, metricId: id,
  rule: researchConsistencyRuleSchema
}).refine(value => value.end > value.start, {message: 'research_consistency_span_invalid'});
export const researchConsistencySaveSchema = z.strictObject({
  projectId: id, artifactId: id, requestId: id, expectedArtifactVersion: hash,
  parent: z.strictObject({reviewId: id, reviewHash: hash}).nullable(),
  rationale: note, bindings: researchConsistencyBindingSchema.array().min(1).max(200)
}).refine(value => new Set(value.bindings.map(b => `${b.claimId}:${b.start}:${b.end}`)).size === value.bindings.length,
{message: 'research_consistency_duplicate_location'});
export const researchConsistencyCalculationSchema = z.strictObject({
  observedText: z.string().min(1), observed: z.number(), sourceValue: z.number(), sourceUnit: id,
  convertedValue: z.number(), expectedValue: z.number(), expectedText: z.string().min(1),
  difference: z.number().nonnegative(), allowedDifference: z.number().nonnegative(),
  consistent: z.boolean()
});
export const researchConsistencySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), id, version: z.number().int().positive(),
  request: researchConsistencySaveSchema, actor: researchRelationReviewerSchema, recordedAt: z.string().datetime(),
  material: z.array(z.strictObject({
    claim: researchClaimSchema, evidence: researchEvidenceSchema,
    result: researchExperimentResultReceiptSchema, calculation: researchConsistencyCalculationSchema
  })).min(1).max(200)
});
export const researchConsistencyReceiptSchema = z.strictObject({snapshot: researchConsistencySnapshotSchema, snapshotHash: hash});
export const researchConsistencyHistorySchema = z.strictObject({
  projectId: id, artifactId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const researchConsistencyHistoryResultSchema = z.strictObject({
  verification: z.literal('stored_receipt'), items: researchConsistencyReceiptSchema.array(), total: z.number().int().nonnegative()
});
export const researchConsistencyInspectSchema = z.strictObject({projectId: id, artifactId: id, expectedHash: hash.nullable()});
export const researchConsistencyReportSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, artifactId: id, artifactVersion: hash,
  review: researchConsistencyReceiptSchema.nullable(),
  locations: z.array(z.strictObject({
    binding: researchConsistencyBindingSchema, calculation: researchConsistencyCalculationSchema,
    current: z.boolean()
  })),
  unmappedClaimIds: id.array(),
  unmappedLocations: z.array(z.strictObject({claimId: id, start: z.number().int().nonnegative(),
    end: z.number().int().positive(), text: z.string().min(1)})),
  counts: z.strictObject({mapped: z.number().int().nonnegative(), consistent: z.number().int().nonnegative(),
    inconsistent: z.number().int().nonnegative(), changed: z.number().int().nonnegative(),
    unmappedClaims: z.number().int().nonnegative(), unmappedValues: z.number().int().nonnegative()})
});
export const researchConsistencyInspectionSchema = z.strictObject({
  status: z.enum(['current', 'stale']), report: researchConsistencyReportSchema,
  reportHash: hash, readAt: z.string().datetime()
});
export const researchConsistencyHeadSchema = z.strictObject({
  reviewId: id, reviewHash: hash, version: z.number().int().positive(), recordedAt: z.string().datetime()
});
export type ResearchConsistencySave = z.infer<typeof researchConsistencySaveSchema>;
export type ResearchConsistencyBinding = z.infer<typeof researchConsistencyBindingSchema>;
export type ResearchConsistencyCalculation = z.infer<typeof researchConsistencyCalculationSchema>;
export type ResearchConsistencyReceipt = z.infer<typeof researchConsistencyReceiptSchema>;
export type ResearchConsistencyHistory = z.infer<typeof researchConsistencyHistorySchema>;
export type ResearchConsistencyInspect = z.infer<typeof researchConsistencyInspectSchema>;
export type ResearchConsistencyInspection = z.infer<typeof researchConsistencyInspectionSchema>;
