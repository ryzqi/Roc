import {z} from 'zod';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchExperimentExecutionSchema} from './research-experiments';

const id = z.string().trim().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchSourceReplacementRequestSchema = z.object({
  projectId: id, requestId: id, kind: z.enum(['document_replacement', 'experiment_rerun']),
  evidenceId: id, targetEvidenceId: id, expectedSourceDigest: digest, expectedTargetDigest: digest,
  note: z.string().trim().min(1).max(10000).nullable()
}).strict();
export const researchSourceReplacementListSchema = z.object({projectId: id, evidenceId: id}).strict();
export const researchSourceReplacementGetSchema = z.object({projectId: id, replacementId: id}).strict();
export const researchSourceReplacementSchema = z.object({
  id, projectId: id, request: researchSourceReplacementRequestSchema, requestHash: digest,
  actor: researchRelationReviewerSchema, source: researchInspectedEvidenceSchema, sourceDigest: digest,
  supersededSource: researchInspectedEvidenceSchema, supersededSourceDigest: digest,
  target: researchInspectedEvidenceSchema, targetDigest: digest,
  experimentLineage: z.object({
    previous: researchExperimentExecutionSchema, previousHash: digest,
    current: researchExperimentExecutionSchema, currentHash: digest
  }).strict().nullable(),
  scientificReviewAtSelection: z.literal('needs_review'), createdAt: id
}).strict().superRefine((value, context) => {
  const {request, source, supersededSource, target, experimentLineage} = value;
  if (value.projectId !== request.projectId || source.evidence.projectId !== request.projectId ||
      target.evidence.projectId !== request.projectId || source.evidence.id !== request.evidenceId ||
      target.evidence.id !== request.targetEvidenceId || source.evidence.id === target.evidence.id ||
      JSON.stringify(source.evidence) !== JSON.stringify(supersededSource.evidence) ||
      JSON.stringify(source.sourceLocator) !== JSON.stringify(supersededSource.sourceLocator) ||
      supersededSource.referenceStatus !== 'superseded' || supersededSource.invalidatedAt === null ||
      target.referenceStatus !== 'recorded' || target.invalidatedAt !== null ||
      request.expectedSourceDigest !== value.sourceDigest || request.expectedTargetDigest !== value.targetDigest) {
    context.addIssue({code: 'custom', message: 'A replacement must bind real distinct sources and preserve the original evidence.'});
  }
  if (request.kind === 'document_replacement') {
    if (experimentLineage !== null || source.sourceLocator === null || target.sourceLocator === null ||
        source.sourceLocator.documentId === target.sourceLocator.documentId) {
      context.addIssue({code: 'custom', message: 'A document replacement requires two explicitly selected documents.'});
    }
  } else if (experimentLineage === null || source.evidence.sourceType !== 'experiment' ||
      target.evidence.sourceType !== 'experiment' || experimentLineage.previous.id !== source.evidence.sourceId ||
      experimentLineage.current.id !== target.evidence.sourceId || experimentLineage.previous.id === experimentLineage.current.id ||
      [experimentLineage.previous, experimentLineage.current].some(run => run.projectId !== value.projectId ||
        run.status !== 'completed' || run.environment === null || run.inputHash === null || run.exitCode !== 0 || run.error !== null)) {
    context.addIssue({code: 'custom', message: 'Rerun lineage must capture two actual completed executions, not label similarity.'});
  }
});
export const researchSourceReplacementInspectionSchema = z.object({
  replacement: researchSourceReplacementSchema, replacementHash: digest,
  targetReferenceStatus: z.enum(['recorded', 'superseded'])
}).strict();
export type ResearchSourceReplacementRequest = z.infer<typeof researchSourceReplacementRequestSchema>;
export type ResearchSourceReplacement = z.infer<typeof researchSourceReplacementSchema>;
export type ResearchSourceReplacementInspection = z.infer<typeof researchSourceReplacementInspectionSchema>;
