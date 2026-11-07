import {z} from 'zod';
import {researchConsistencyCalculationSchema, researchConsistencyRuleSchema, researchConsistencyHistorySchema} from './research-consistency';
import {researchClaimSchema, researchEvidenceSchema} from './research-evidence';
import {researchExperimentResultReceiptSchema} from './research-experiment-results';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchFigurePublicationSchema, researchFigureRunSchema} from './research-figures';
import {researchFigureDataItemSchema, researchFigureDataMarkSchema, researchFigureDataFileSchema} from './research-figure-data';

const id = z.string().trim().min(1).max(128);
const name = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const note = z.string().trim().min(1).max(4000);
export const researchFigureConsistencyBindingSchema = z.strictObject({
  claimId: id, expectedClaimHash: hash, markName: name, channel: name, field: name,
  scenePath: researchFigureDataItemSchema.shape.scenePath,
  unit: id, evidenceId: id, resultId: id, resultHash: hash, metricId: id,
  rule: researchConsistencyRuleSchema
});
export const researchFigureConsistencySaveSchema = z.strictObject({
  projectId: id, artifactId: id, requestId: id, expectedArtifactVersion: hash,
  figure: z.strictObject({id, manifestHash: hash, traceHash: hash}),
  parent: z.strictObject({reviewId: id, reviewHash: hash}).nullable(), rationale: note,
  bindings: researchFigureConsistencyBindingSchema.array().min(1).max(200)
}).refine(value => new Set(value.bindings.map(b => JSON.stringify([b.markName, b.channel, b.scenePath]))).size === value.bindings.length,
{message: 'research_figure_consistency_duplicate_location'});
export const researchFigureConsistencyMaterialSchema = z.strictObject({
  figure: researchFigurePublicationSchema,
  run: researchFigureRunSchema,
  trace: z.strictObject({file: researchFigureDataFileSchema, sourceHash: hash, rendererHash: hash, compiledSpecHash: hash}),
  mappings: z.array(z.strictObject({
    mark: researchFigureDataMarkSchema.omit({items: true}), item: researchFigureDataItemSchema,
    claim: researchClaimSchema, evidence: researchEvidenceSchema, result: researchExperimentResultReceiptSchema,
    calculation: researchConsistencyCalculationSchema
  })).min(1).max(200)
});
export const researchFigureConsistencyReceiptSchema = z.strictObject({
  snapshot: z.strictObject({
    schemaVersion: z.literal(1), id, version: z.number().int().positive(), request: researchFigureConsistencySaveSchema,
    actor: researchRelationReviewerSchema, recordedAt: z.string().datetime(), material: researchFigureConsistencyMaterialSchema
  }), snapshotHash: hash
});
export const researchFigureConsistencyInspectSchema = z.strictObject({
  projectId: id, artifactId: id, expectedHash: hash.nullable(),
  page: z.strictObject({markName: name.nullable(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(200)})
});
export const researchFigureConsistencyInspectionSchema = z.strictObject({
  status: z.enum(['current', 'stale']), reportHash: hash, readAt: z.string().datetime(),
  report: z.strictObject({
    projectId: id, artifactId: id, artifactVersion: hash,
    figure: researchFigurePublicationSchema, trace: researchFigureConsistencyMaterialSchema.shape.trace,
    marks: researchFigureDataMarkSchema.omit({items: true}).extend({itemCount: z.number().int().nonnegative()}).array().max(1000),
    page: researchFigureConsistencyInspectSchema.shape.page,
    items: researchFigureDataItemSchema.array().max(200), total: z.number().int().nonnegative(),
    review: researchFigureConsistencyReceiptSchema.nullable(),
    locations: z.array(z.strictObject({
      binding: researchFigureConsistencyBindingSchema, calculation: researchConsistencyCalculationSchema, current: z.boolean()
    })).max(200),
    counts: z.strictObject({
      numericLocations: z.number().int().nonnegative(), unmapped: z.number().int().nonnegative(),
      consistent: z.number().int().nonnegative(), inconsistent: z.number().int().nonnegative(), changed: z.number().int().nonnegative()
    })
  })
});
export const researchFigureConsistencyHistorySchema = researchConsistencyHistorySchema;
export const researchFigureConsistencyHistoryResultSchema = z.strictObject({
  verification: z.literal('stored_receipt'), items: researchFigureConsistencyReceiptSchema.array(), total: z.number().int().nonnegative()
});

export type ResearchFigureConsistencyBinding = z.infer<typeof researchFigureConsistencyBindingSchema>;
export type ResearchFigureConsistencySave = z.infer<typeof researchFigureConsistencySaveSchema>;
export type ResearchFigureConsistencyMaterial = z.infer<typeof researchFigureConsistencyMaterialSchema>;
export type ResearchFigureConsistencyReceipt = z.infer<typeof researchFigureConsistencyReceiptSchema>;
export type ResearchFigureConsistencyInspect = z.infer<typeof researchFigureConsistencyInspectSchema>;
export type ResearchFigureConsistencyInspection = z.infer<typeof researchFigureConsistencyInspectionSchema>;
export type ResearchFigureConsistencyHistory = z.infer<typeof researchFigureConsistencyHistorySchema>;
