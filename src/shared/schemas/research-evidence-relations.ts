import {z} from 'zod';
import {researchInspectedEvidenceSchema} from './research-evidence-source';

const identifier = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const version = z.number().int().positive();
export const researchRelationActorSchema = z.object({
  kind: z.enum(['user', 'agent']), id: identifier
}).strict();
export const researchRelationReviewerSchema = researchRelationActorSchema.extend({kind: z.literal('user')});
export const researchRelationKindSchema = z.enum(['supports', 'contradicts', 'qualifies', 'depends_on', 'supersedes']);
const condition = z.string().trim().min(1).max(10000).nullable();

export const researchEvidenceRelationProposalSchema = z.object({
  projectId: identifier, claimId: identifier, expectedClaimVersion: version,
  evidenceId: identifier, expectedSourceDigest: hash, kind: researchRelationKindSchema,
  condition, supersedesRelationId: identifier.nullable()
}).strict().superRefine((value, context) => {
  if (value.kind === 'qualifies' && value.condition === null) {
    context.addIssue({code: 'custom', message: 'A qualifying relation requires its condition.', path: ['condition']});
  }
  if ((value.kind === 'supersedes') !== (value.supersedesRelationId !== null)) {
    context.addIssue({code: 'custom', message: 'A superseding relation requires the previous relation.', path: ['supersedesRelationId']});
  }
});

export const researchEvidenceRelationSchema = z.object({
  id: identifier, projectId: identifier, artifactId: identifier, claimId: identifier,
  claimVersion: version, claimHash: hash, evidenceId: identifier,
  source: researchInspectedEvidenceSchema, sourceDigest: hash,
  kind: z.enum([...researchRelationKindSchema.options, 'historical']),
  condition, supersedesRelationId: identifier.nullable(),
  proposer: researchRelationActorSchema.nullable(),
  status: z.enum(['proposed', 'confirmed', 'rejected', 'invalidated', 'historical']),
  version, reviewer: researchRelationReviewerSchema.nullable(), reviewedAt: identifier.nullable(),
  decisionNote: condition,
  invalidatedReason: z.enum(['claim_changed', 'evidence_invalidated', 'superseded']).nullable(),
  createdAt: identifier, updatedAt: identifier
}).strict().superRefine((value, context) => {
  if (value.kind === 'historical' && (value.proposer !== null || value.reviewer !== null ||
      value.reviewedAt !== null || value.decisionNote !== null || value.condition !== null ||
      value.supersedesRelationId !== null || !['historical', 'invalidated'].includes(value.status))) {
    context.addIssue({code: 'custom', message: 'Historical associations have no invented proposer or review.'});
  }
  if (['confirmed', 'rejected'].includes(value.status) && (value.reviewer === null || value.reviewedAt === null)) {
    context.addIssue({code: 'custom', message: 'A human decision requires its reviewer and time.'});
  }
  if (value.status === 'proposed' && (value.proposer === null || value.reviewer !== null || value.reviewedAt !== null)) {
    context.addIssue({code: 'custom', message: 'Proposals cannot contain a human decision.'});
  }
  if ((value.status === 'invalidated') !== (value.invalidatedReason !== null)) {
    context.addIssue({code: 'custom', message: 'Invalidation requires an explicit reason.'});
  }
  if (value.status === 'historical' && value.kind !== 'historical') {
    context.addIssue({code: 'custom', message: 'Only a historical association can have historical status.'});
  }
  if ((value.reviewer === null) !== (value.reviewedAt === null)) {
    context.addIssue({code: 'custom', message: 'Reviewer and review time must be present together.'});
  }
  if (value.kind === 'qualifies' && value.condition === null) {
    context.addIssue({code: 'custom', message: 'A qualifying relation requires its condition.'});
  }
  if ((value.kind === 'supersedes') !== (value.supersedesRelationId !== null)) {
    context.addIssue({code: 'custom', message: 'A superseding relation requires the previous relation.'});
  }
});
export const researchEvidenceRelationReviewSchema = z.object({
  projectId: identifier, relationId: identifier, expectedVersion: version,
  expectedClaimVersion: version, expectedSourceDigest: hash,
  decision: z.enum(['confirm', 'reject']), note: condition
}).strict();
export const researchEvidenceRelationListSchema = z.object({projectId: identifier, claimId: identifier.nullable()}).strict();
export const researchEvidenceRelationHistorySchema = z.object({projectId: identifier, relationId: identifier}).strict();
export const researchEvidenceRelationRevisionSchema = z.object({
  relation: researchEvidenceRelationSchema,
  actor: z.union([researchRelationActorSchema, z.object({kind: z.literal('system'), id: identifier}).strict()]).nullable(),
  event: z.enum(['historical', 'proposed', 'confirmed', 'rejected', 'invalidated']),
  recordedAt: identifier
}).strict();
export type ResearchEvidenceRelation = z.infer<typeof researchEvidenceRelationSchema>;
export type ResearchEvidenceRelationProposal = z.infer<typeof researchEvidenceRelationProposalSchema>;
export type ResearchEvidenceRelationReview = z.infer<typeof researchEvidenceRelationReviewSchema>;
export type ResearchRelationActor = z.infer<typeof researchRelationActorSchema>;
export type ResearchRelationReviewer = z.infer<typeof researchRelationReviewerSchema>;
export type ResearchEvidenceRelationRevision = z.infer<typeof researchEvidenceRelationRevisionSchema>;
