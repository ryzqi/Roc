import {z} from 'zod';
import {researchClaimSchema, researchManuscriptSchema} from './research-evidence';
import {researchCitationCoverageBodySchema} from './research-citation-coverage';
import {researchFigureValidationSchema} from './research-plotting';
import {researchExperimentPathSchema} from './research-experiments';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const note = z.string().trim().min(1).max(12000);
const ruleFields = {
  id, label: id, sourceUrl: z.url({protocol: /^https?$/u}), excerpt: note, authority: z.enum(['required', 'guidance'])
};
export const researchJournalRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({...ruleFields, kind: z.literal('sections'), titles: id.array().min(1).max(100)}),
  z.strictObject({...ruleFields, kind: z.literal('reference_count'), maximum: z.number().int().nonnegative().max(5000)}),
  z.strictObject({...ruleFields, kind: z.literal('reference_fields'),
    fields: z.enum(['title', 'authors', 'doi', 'publishedYear', 'url']).array().min(1).max(5)}),
  z.strictObject({...ruleFields, kind: z.literal('figure_files'), format: z.enum(['png', 'svg', 'pdf']),
    maximumBytes: z.number().int().positive().max(64 * 1024 * 1024),
    minimumDpi: z.number().int().positive().max(1200).nullable(),
    maximumWidthPoints: z.number().positive().nullable(), maximumHeightPoints: z.number().positive().nullable()})
    .refine(rule => rule.minimumDpi === null || rule.format === 'png', 'research_journal_raster_dpi_required'),
  z.strictObject({...ruleFields, kind: z.literal('supplements'), paths: researchExperimentPathSchema.array().min(1).max(100)}),
  z.strictObject({...ruleFields, kind: z.literal('manual'), area: z.enum(['structure', 'references', 'figures', 'supplements'])})
]);
export const researchJournalProfileSchema = z.strictObject({
  journal: id, articleType: id, submissionStage: id, version: id,
  revisionDate: z.iso.date(), dateAuthority: z.enum(['official', 'human_transcription']),
  retrievedAt: z.string().datetime(), rules: researchJournalRuleSchema.array().min(1).max(200)
}).refine(profile => new Set(profile.rules.map(rule => rule.id)).size === profile.rules.length,
  'research_journal_duplicate_rule');
export const researchJournalSelectionSchema = z.strictObject({
  profile: researchJournalProfileSchema, figureIds: id.array().max(100),
  supplementPaths: researchExperimentPathSchema.array().max(100),
  manualReviews: z.strictObject({ruleId: id, decision: z.enum(['pass', 'fail', 'not_applicable']), rationale: note}).array().max(200)
}).superRefine((selection, ctx) => {
  if (new Set(selection.figureIds).size !== selection.figureIds.length ||
    new Set(selection.supplementPaths).size !== selection.supplementPaths.length ||
    new Set(selection.manualReviews.map(review => review.ruleId)).size !== selection.manualReviews.length) {
    ctx.addIssue({code: 'custom', message: 'research_journal_duplicate_reference'});
  }
  if (selection.manualReviews.some(review => !selection.profile.rules.some(rule => rule.id === review.ruleId && rule.kind === 'manual'))) {
    ctx.addIssue({code: 'custom', message: 'research_journal_manual_rule_required'});
  }
});
export const researchJournalSaveSchema = z.strictObject({
  projectId: id, artifactId: id, requestId: id, expectedArtifactVersion: hash, expectedMaterialHash: hash,
  parent: z.strictObject({reviewId: id, reviewHash: hash}).nullable(), rationale: note,
  selection: researchJournalSelectionSchema
});
export const researchJournalMaterialSchema = z.strictObject({
  manuscript: researchManuscriptSchema, claims: researchClaimSchema.array(),
  sources: researchCitationCoverageBodySchema.shape.sources,
  figures: z.strictObject({id, projectId: id, artifactId: id, runId: id, manifestHash: hash,
    validation: researchFigureValidationSchema}).array(),
  supplements: z.strictObject({path: researchExperimentPathSchema, size: z.number().int().nonnegative(), sha256: hash}).array()
});
export const researchJournalCheckSchema = z.strictObject({
  ruleId: id, status: z.enum(['pass', 'fail', 'manual']), subjectIds: z.string().min(1).max(1024).array(), detail: note
});
export const researchJournalReceiptSchema = z.strictObject({
  snapshot: z.strictObject({
    schemaVersion: z.literal(1), id, version: z.number().int().positive(),
    request: researchJournalSaveSchema, actor: researchRelationReviewerSchema,
    recordedAt: z.string().datetime(), material: researchJournalMaterialSchema,
    checks: researchJournalCheckSchema.array()
  }), snapshotHash: hash
});
export const researchJournalInspectSchema = z.strictObject({
  projectId: id, artifactId: id, selection: researchJournalSelectionSchema.nullable(), expectedHash: hash.nullable()
});
export const researchJournalInspectionSchema = z.strictObject({
  status: z.enum(['current', 'stale']), reportHash: hash,
  report: z.strictObject({
    projectId: id, artifactId: id, artifactVersion: hash, selection: researchJournalSelectionSchema.nullable(),
    material: researchJournalMaterialSchema.nullable(), materialHash: hash.nullable(),
    checks: researchJournalCheckSchema.array(), review: researchJournalReceiptSchema.nullable(), reviewCurrent: z.boolean()
  })
});
export const researchJournalHistorySchema = z.strictObject({
  projectId: id, artifactId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const researchJournalHistoryResultSchema = z.strictObject({
  verification: z.literal('stored_receipt'), items: researchJournalReceiptSchema.array(), total: z.number().int().nonnegative()
});
export type ResearchJournalSelection = z.infer<typeof researchJournalSelectionSchema>;
export type ResearchJournalMaterial = z.infer<typeof researchJournalMaterialSchema>;
export type ResearchJournalSave = z.infer<typeof researchJournalSaveSchema>;
export type ResearchJournalReceipt = z.infer<typeof researchJournalReceiptSchema>;
export type ResearchJournalInspect = z.infer<typeof researchJournalInspectSchema>;
export type ResearchJournalInspection = z.infer<typeof researchJournalInspectionSchema>;
export type ResearchJournalHistory = z.infer<typeof researchJournalHistorySchema>;
