import {z} from 'zod';
import {scientificSourceRefSchema} from './research-scientific-source-ref';
import {scientificQueryResultSchema} from './research-scientific-query';
import {scientificFactSchema} from './research-scientific-facts';
import {researchClaimSchema} from './research-evidence';

const id = z.string().trim().min(1).max(2048);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const messages = z.array(z.string().min(1).max(20000)).max(600);
export const prepareWritingContextRequestSchema = z.object({
  projectId: id, artifactId: id, sectionTitle: z.string().trim().min(1).max(300),
  sectionGoal: z.string().trim().min(1).max(2000), documentIds: z.array(id).max(100).default([])
}).strict();
export const writingContextRequestSchema = z.object({projectId: id, artifactId: id, contextId: id}).strict();
export const writingContextResultSchema = z.object({
  contextId: id, basisDigest: digest, projectId: id, artifactId: id,
  sourcePapers: z.array(scientificSourceRefSchema).max(600), relevantFacts: messages,
  originalEvidenceIds: z.array(id).max(600), supportingClaims: z.array(id).max(500),
  counterEvidence: messages, knowledgeGaps: messages, limitations: messages,
  status: z.enum(['ready', 'incomplete'])
}).strict();
export const writingGroundingIssueSchema = z.object({
  code: z.enum(['source_stale', 'context_changed', 'claim_changed', 'manuscript_missing', 'manuscript_stale',
    'evidence_missing', 'human_review_required', 'conditions_missing', 'numeric_mismatch', 'unit_mismatch',
    'inference_as_fact', 'counterevidence_missing', 'context_incomplete']),
  message: z.string().min(1).max(2000), claimId: id.nullable(), evidenceId: id.nullable(),
  documentId: id.nullable(), sectionIndex: z.number().int().nonnegative().nullable(),
  sectionTitle: z.string().nullable(), paragraphIndex: z.number().int().nonnegative().nullable(),
  span: z.object({start: z.number().int().nonnegative(), end: z.number().int().positive()}).strict().nullable()
}).strict();
export const writingGroundingResultSchema = writingContextRequestSchema.extend({
  basisDigest: digest, status: z.enum(['ready', 'incomplete']),
  issues: z.array(writingGroundingIssueSchema).max(5000), checkedClaimIds: z.array(id).max(50000)
}).strict();
export const writingImpactResultSchema = writingContextRequestSchema.extend({
  basisDigest: digest, status: z.enum(['current', 'changed']),
  impacts: z.array(z.object({
    kind: z.enum(['source', 'wiki', 'evidence', 'claim', 'paragraph', 'configuration', 'artifact']),
    id, reason: z.string().min(1).max(2000), claimIds: z.array(id).max(50000),
    sectionIndexes: z.array(z.number().int().nonnegative()).max(100)
  }).strict()).max(5000), requiresHumanRevision: z.boolean()
}).strict();

/** Stored in existing workflow-event/provenance records; no parallel manuscript or evidence store. */
export const writingContextReceiptSchema = z.object({
  version: z.literal('roc-writing-context/1'), result: writingContextResultSchema,
  request: prepareWritingContextRequestSchema, projectGoal: z.string(), artifactDigest: digest,
  config: z.object({retrieval: digest, knowledge: digest}).strict(),
  retrievals: z.array(scientificQueryResultSchema).min(1).max(2),
  wiki: z.array(z.object({pageId: id, revision: z.number().int().nonnegative(), basisDigest: digest}).strict()).max(8),
  facts: z.array(scientificFactSchema).max(200),
  bindings: z.array(z.object({source: scientificSourceRefSchema, evidenceId: id}).strict()).max(600),
  claims: z.array(researchClaimSchema).max(500),
  manuscriptDigest: digest.nullable(), relationsDigest: digest, createdAt: z.string().min(1)
}).strict();
export type PrepareWritingContextRequest = z.infer<typeof prepareWritingContextRequestSchema>;
export type WritingContextRequest = z.infer<typeof writingContextRequestSchema>;
export type WritingContextResult = z.infer<typeof writingContextResultSchema>;
export type WritingContextReceipt = z.infer<typeof writingContextReceiptSchema>;
export type WritingGroundingIssue = z.infer<typeof writingGroundingIssueSchema>;
export type WritingGroundingResult = z.infer<typeof writingGroundingResultSchema>;
export type WritingImpactResult = z.infer<typeof writingImpactResultSchema>;
