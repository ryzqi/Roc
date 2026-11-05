import {z} from 'zod';
import {researchClaimSchema, researchManuscriptSchema} from './research-evidence';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema} from './research-evidence-relations';
import {researchBibliographyEntrySchema} from './research-library';
import {researchCitationReviewReceiptSchema} from './research-citation-reviews';

const id = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const researchCitationCoverageRequestSchema = z.strictObject({
  projectId: id, artifactId: id, expectedHash: hash.nullable()
});
export const researchCitationCoverageBodySchema = z.strictObject({
  schemaVersion: z.literal(2), projectId: id, artifactId: id, artifactVersion: hash,
  manuscript: researchManuscriptSchema,
  sources: z.array(z.strictObject({
    source: researchInspectedEvidenceSchema,
    manuscriptCitationKey: id,
    locationLevel: z.enum(['locator', 'page', 'region']),
    bibliography: z.strictObject({
      itemId: id, revision: z.number().int().positive(), archived: z.boolean(),
      entry: researchBibliographyEntrySchema
    }).nullable()
  })),
  paragraphs: z.array(z.strictObject({
    sectionIndex: z.number().int().nonnegative(), sectionTitle: id,
    paragraphIndex: z.number().int().nonnegative(), claim: researchClaimSchema,
    relations: z.array(researchEvidenceRelationSchema),
    citations: z.array(z.strictObject({
      evidenceId: id, manuscriptCitationKey: id,
      supportReview: z.enum(['unreviewed', 'confirmed', 'qualified']),
      supportRelationIds: z.array(id),
      directnessReview: z.strictObject({current: z.boolean(), receipt: researchCitationReviewReceiptSchema}).nullable()
    })),
    issues: z.array(z.strictObject({
      kind: z.enum(['unreviewed_support', 'confirmed_contradiction', 'changed_relation', 'figure_claim_in_body', 'archived_bibliography',
        'unreviewed_directness', 'changed_directness', 'indirect_citation', 'unsupported_citation']),
      subjectId: id
    }))
  })),
  counts: z.strictObject({
    paragraphs: z.number().int().nonnegative(), citations: z.number().int().nonnegative(),
    humanReviewedCitations: z.number().int().nonnegative(), qualifiedCitations: z.number().int().nonnegative(),
    paragraphsWithIssues: z.number().int().nonnegative(),
    directCitations: z.number().int().nonnegative(), indirectCitations: z.number().int().nonnegative(),
    unsupportedCitations: z.number().int().nonnegative(), unreviewedDirectnessCitations: z.number().int().nonnegative()
  })
});
export const researchCitationCoverageInspectionSchema = z.strictObject({
  status: z.enum(['current', 'stale']), report: researchCitationCoverageBodySchema,
  reportHash: hash, readAt: z.string().datetime()
});
export type ResearchCitationCoverageRequest = z.infer<typeof researchCitationCoverageRequestSchema>;
export type ResearchCitationCoverageBody = z.infer<typeof researchCitationCoverageBodySchema>;
export type ResearchCitationCoverageInspection = z.infer<typeof researchCitationCoverageInspectionSchema>;
