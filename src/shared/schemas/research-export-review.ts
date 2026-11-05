import {z} from 'zod';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema, researchEvidenceRelationRevisionSchema} from './research-evidence-relations';
import {researchIdeaOutcomeReceiptSchema, researchIdeaOutcomeHistoryResultSchema} from './research-idea-outcomes';

const id = z.string().trim().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const researchExportScientificReviewSchema = z.object({
  schemaVersion: z.literal(2),
  projectId: id,
  sourceHash: digest,
  claims: z.array(z.object({claimId: id, version: z.number().int().positive(), hash: digest}).strict()),
  evidence: z.array(researchInspectedEvidenceSchema),
  relations: z.array(researchEvidenceRelationSchema),
  history: z.array(z.object({relationId: id, revisions: z.array(researchEvidenceRelationRevisionSchema)}).strict()),
  ideaOutcomes: z.array(researchIdeaOutcomeReceiptSchema),
  ideaOutcomeHistory: z.array(z.strictObject({planVersionId: id, history: researchIdeaOutcomeHistoryResultSchema}))
}).strict();

export type ResearchExportScientificReview = z.infer<typeof researchExportScientificReviewSchema>;
