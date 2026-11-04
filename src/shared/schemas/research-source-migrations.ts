import {z} from 'zod';
import {researchDocumentContentSchema} from './research-documents';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const researchSourceMigrationProposalSchema = z.object({
  id, projectId: id, evidenceId: id,
  source: researchInspectedEvidenceSchema, sourceDigest: digest,
  documentId: id, targetParseId: id, targetSourceHash: digest, targetParseHash: digest,
  parserFingerprint: digest,
  matchingRule: z.literal('exact_text_then_whitespace/1'),
  match: z.enum(['exact_text', 'normalized_text', 'ambiguous', 'no_match']),
  targets: z.array(z.object({chunkId: id, block: researchDocumentContentSchema.shape.blocks.element}).strict()),
  status: z.literal('needs_review'),
  createdAt: id
}).strict().superRefine((value, context) => {
  if (value.source.evidence.id !== value.evidenceId || value.source.evidence.projectId !== value.projectId ||
      value.source.sourceLocator === null || value.source.sourceLocator.documentId !== value.documentId ||
      value.source.sourceLocator.parseId === value.targetParseId || value.source.referenceStatus !== 'superseded') {
    context.addIssue({code: 'custom', message: 'A migration proposal must bind an invalidated captured source and a different parse.'});
  }
  if ((value.match === 'no_match' && value.targets.length !== 0) ||
      (value.match === 'ambiguous' && value.targets.length < 2) ||
      (['exact_text', 'normalized_text'].includes(value.match) && value.targets.length !== 1)) {
    context.addIssue({code: 'custom', message: 'The matching outcome must describe the actual targets.'});
  }
});

export const researchSourceMigrationListSchema = z.object({projectId: id, evidenceId: id}).strict();
export const researchSourceMigrationGetSchema = z.object({projectId: id, proposalId: id}).strict();
const decisionFields = {
  projectId: id, proposalId: id, requestId: id,
  expectedProposalHash: digest, expectedSourceDigest: digest, expectedTargetParseHash: digest,
  note: z.string().trim().min(1).max(10000).nullable()
};
export const researchSourceMigrationCaptureSchema = z.object({
  ...decisionFields, action: z.literal('capture'), chunkId: id
}).strict();
export const researchSourceMigrationRejectSchema = z.object({
  ...decisionFields, action: z.literal('reject')
}).strict();
export const researchSourceMigrationDecisionRequestSchema = z.discriminatedUnion('action', [
  researchSourceMigrationCaptureSchema, researchSourceMigrationRejectSchema
]);
export const researchSourceMigrationDecisionSchema = z.object({
  id, projectId: id, proposalId: id, evidenceId: id,
  request: researchSourceMigrationDecisionRequestSchema, requestHash: digest,
  actor: researchRelationReviewerSchema,
  capturedSource: researchInspectedEvidenceSchema.nullable(), capturedSourceDigest: digest.nullable(),
  recordedAt: id
}).strict().superRefine((value, context) => {
  if (value.projectId !== value.request.projectId || value.proposalId !== value.request.proposalId ||
      (value.request.action === 'capture') !== (value.capturedSource !== null) ||
      (value.capturedSource === null) !== (value.capturedSourceDigest === null)) {
    context.addIssue({code: 'custom', message: 'A decision must bind its request and actual capture.'});
  }
  if (value.capturedSource !== null && (value.capturedSource.evidence.projectId !== value.projectId ||
      value.capturedSource.evidence.id === value.evidenceId || value.capturedSource.referenceStatus !== 'recorded' ||
      value.capturedSource.invalidatedAt !== null || value.capturedSource.sourceLocator === null ||
      value.request.action !== 'capture' || value.capturedSource.evidence.chunkId !== value.request.chunkId)) {
    context.addIssue({code: 'custom', message: 'A location capture requires a distinct recorded document source.'});
  }
});
export const researchSourceMigrationInspectionSchema = z.object({
  proposal: researchSourceMigrationProposalSchema, proposalHash: digest, targetStatus: z.enum(['current', 'stale']),
  decision: researchSourceMigrationDecisionSchema.nullable(),
  capturedReferenceStatus: z.enum(['recorded', 'superseded']).nullable()
}).strict().superRefine((value, context) => {
  const captured = value.decision !== null && value.decision.capturedSource !== null;
  if (captured !== (value.capturedReferenceStatus !== null)) {
    context.addIssue({code: 'custom', message: 'A captured decision requires its current reference status.'});
  }
});

export type ResearchSourceMigrationProposal = z.infer<typeof researchSourceMigrationProposalSchema>;
export type ResearchSourceMigrationInspection = z.infer<typeof researchSourceMigrationInspectionSchema>;
export type ResearchSourceMigrationDecisionRequest = z.infer<typeof researchSourceMigrationDecisionRequestSchema>;
export type ResearchSourceMigrationDecision = z.infer<typeof researchSourceMigrationDecisionSchema>;
