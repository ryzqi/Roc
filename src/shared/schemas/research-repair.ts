import {z} from 'zod';
import {researchStageSchema, researchWorkflowSnapshotSchema} from './research';
import {researchImpactSourceSchema} from './research-impact';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uniqueIds = id.array().max(500).refine(ids => new Set(ids).size === ids.length);
export const researchRepairStartSchema = z.strictObject({
  projectId: id, source: researchImpactSourceSchema, expectedStage: researchStageSchema, expectedReportHash: hash,
  requestId: id, targetArtifactIds: uniqueIds.refine(ids => ids.length > 0), reason: z.string().trim().min(1).max(4000),
  inputs: z.strictObject({stage: researchStageSchema,
    artifacts: z.strictObject({artifactId: id, expectedVersion: hash}).array().max(500)
      .refine(artifacts => new Set(artifacts.map(artifact => artifact.artifactId)).size === artifacts.length)
  }).array().min(1).max(researchStageSchema.options.length).refine(inputs => new Set(inputs.map(input => input.stage)).size === inputs.length)
});
export const researchRepairReceiptSchema = z.strictObject({
  repairId: id, projectId: id, source: researchImpactSourceSchema, reportHash: hash,
  targetArtifactIds: uniqueIds, stages: researchStageSchema.array(), actor: researchRelationReviewerSchema,
  createdAt: z.string().datetime(), workflow: researchWorkflowSnapshotSchema
});
export type ResearchRepairStart = z.infer<typeof researchRepairStartSchema>;
export type ResearchRepairReceipt = z.infer<typeof researchRepairReceiptSchema>;

/** Repairing a manuscript requires a fresh writing and review cycle; no approval is transferred. */
export function researchRepairStages(targets: ReadonlyArray<{stage: z.infer<typeof researchStageSchema>}>): Array<z.infer<typeof researchStageSchema>> {
  const stages = new Set<z.infer<typeof researchStageSchema>>(targets.map(target => target.stage === 'revision' ? 'writing' : target.stage));
  if (stages.has('writing')) {stages.add('review'); stages.add('export');}
  if (stages.has('review')) stages.add('export');
  return researchStageSchema.options.filter(stage => stages.has(stage));
}
