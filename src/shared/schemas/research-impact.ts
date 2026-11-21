import {z} from 'zod';
import {researchStageSchema} from './research';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchImpactSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('artifact'), artifactId: id, expectedVersion: hash}),
  z.strictObject({kind: z.literal('evidence'), evidenceId: id, expectedSourceDigest: hash}),
  z.strictObject({kind: z.literal('result'), resultId: id, expectedHash: hash})
]);
export const researchImpactInspectSchema = z.strictObject({projectId: id, source: researchImpactSourceSchema});
export const researchImpactReasonSchema = z.strictObject({
  kind: z.enum(['source', 'claim_evidence', 'evidence_relation', 'result_evidence', 'experiment_result',
    'numeric_mapping', 'figure_mapping', 'response_evidence', 'journal_figure', 'export_source', 'run_context',
    'idea_plan', 'idea_outcome', 'manuscript_revision', 'scientific_review']),
  subjectId: id, detail: z.string().min(1).max(1000)
});
export const researchImpactReportSchema = researchImpactInspectSchema.extend({
  reportHash: hash, coverage: z.literal('recorded_relationships'),
  affected: z.strictObject({artifactId: id, stage: researchStageSchema, title: z.string(),
    reasons: researchImpactReasonSchema.array().min(1)}).array(),
  preservedArtifactIds: id.array(), stale: z.boolean()
});
export type ResearchImpactSource = z.infer<typeof researchImpactSourceSchema>;
export type ResearchImpactInspect = z.infer<typeof researchImpactInspectSchema>;
export type ResearchImpactReason = z.infer<typeof researchImpactReasonSchema>;
export type ResearchImpactReport = z.infer<typeof researchImpactReportSchema>;
