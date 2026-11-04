import {z} from 'zod';
import {researchDocumentContentSchema} from './research-documents';
import {researchInspectedEvidenceSchema} from './research-evidence-source';

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
export const researchSourceMigrationInspectionSchema = z.object({
  proposal: researchSourceMigrationProposalSchema, targetStatus: z.enum(['current', 'stale'])
}).strict();

export type ResearchSourceMigrationProposal = z.infer<typeof researchSourceMigrationProposalSchema>;
export type ResearchSourceMigrationInspection = z.infer<typeof researchSourceMigrationInspectionSchema>;
