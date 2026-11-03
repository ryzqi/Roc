import {z} from 'zod';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema, researchEvidenceRelationRevisionSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const researchExportScientificReviewSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  sourceHash: digest,
  claims: z.array(z.object({claimId: id, version: z.number().int().positive(), hash: digest}).strict()),
  evidence: z.array(researchInspectedEvidenceSchema),
  relations: z.array(researchEvidenceRelationSchema),
  history: z.array(z.object({relationId: id, revisions: z.array(researchEvidenceRelationRevisionSchema)}).strict())
}).strict();

export type ResearchExportScientificReview = z.infer<typeof researchExportScientificReviewSchema>;
