import {z} from 'zod';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema, researchEvidenceRelationRevisionSchema} from './research-evidence-relations';
import {researchIdeaOutcomeReceiptSchema, researchIdeaOutcomeHistoryResultSchema} from './research-idea-outcomes';
import {researchCitationReviewReceiptSchema, researchCitationReviewHistoryResultSchema} from './research-citation-reviews';
import {researchConsistencyReceiptSchema, researchConsistencyHistoryResultSchema} from './research-consistency';
import {researchFigureConsistencyReceiptSchema} from './research-figure-consistency';
import {researchResponseMatrixReceiptSchema, researchResponseMatrixHistoryResultSchema} from './research-response-matrix';
import {researchJournalReceiptSchema, researchJournalHistoryResultSchema} from './research-journal-compliance';

const id = z.string().trim().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const figureSnapshot = researchFigureConsistencyReceiptSchema.shape.snapshot;
const figureMaterial = figureSnapshot.shape.material;
/** A projection cannot establish equality to the private original snapshot or manifest. */
export const researchExportFigureReviewSchema = z.strictObject({
  verification: z.literal('redacted_receipt'),
  omittedFields: z.tuple([z.literal('snapshot.material.run.workspacePath'), z.literal('snapshot.material.run.workspaceRoot')]),
  originalSnapshotHash: digest,
  redactedSnapshotHash: digest,
  snapshot: figureSnapshot.extend({
    material: figureMaterial.extend({run: figureMaterial.shape.run.omit({workspacePath: true, workspaceRoot: true})})
  })
});

export const researchExportScientificReviewSchema = z.object({
  schemaVersion: z.literal(5),
  projectId: id,
  sourceHash: digest,
  claims: z.array(z.object({claimId: id, version: z.number().int().positive(), hash: digest}).strict()),
  evidence: z.array(researchInspectedEvidenceSchema),
  relations: z.array(researchEvidenceRelationSchema),
  history: z.array(z.object({relationId: id, revisions: z.array(researchEvidenceRelationRevisionSchema)}).strict()),
  ideaOutcomes: z.array(researchIdeaOutcomeReceiptSchema),
  ideaOutcomeHistory: z.array(z.strictObject({planVersionId: id, history: researchIdeaOutcomeHistoryResultSchema})),
  citationReviews: z.array(z.strictObject({
    artifactId: id, current: z.array(researchCitationReviewReceiptSchema),
    history: z.array(z.strictObject({claimId: id, evidenceId: id, history: researchCitationReviewHistoryResultSchema}))
  })),
  consistencyReviews: z.array(z.strictObject({
    artifactId: id, current: researchConsistencyReceiptSchema, history: researchConsistencyHistoryResultSchema
  })),
  figureConsistencyReviews: z.array(z.strictObject({
    artifactId: id, current: researchExportFigureReviewSchema,
    history: z.strictObject({verification: z.literal('redacted_receipts'),
      items: z.array(researchExportFigureReviewSchema), total: z.number().int().nonnegative()})
  })),
  responseMatrices: z.array(z.strictObject({
    artifactId: id, current: researchResponseMatrixReceiptSchema, history: researchResponseMatrixHistoryResultSchema
  })),
  journalCompliance: z.array(z.strictObject({
    artifactId: id, current: researchJournalReceiptSchema, history: researchJournalHistoryResultSchema,
    supplementDelivery: z.literal('metadata_only')
  }))
}).strict();

export type ResearchExportScientificReview = z.infer<typeof researchExportScientificReviewSchema>;
export type ResearchExportFigureReview = z.infer<typeof researchExportFigureReviewSchema>;
