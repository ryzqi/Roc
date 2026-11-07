import {z} from 'zod';
import {researchClaimSchema, researchManuscriptSchema} from './research-evidence';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const note = z.string().trim().min(1).max(12000);
export const scientificReviewRulesVersion = 'roc-scientific-review/v1';
export const scientificClaimKinds = ['factual', 'comparative', 'numerical', 'causal', 'experimental', 'novelty', 'hypothesis'] as const;
export const scientificCriteria = {
  factual: ['direct_source'], comparative: ['comparable_conditions', 'baseline'],
  numerical: ['metric', 'unit', 'population', 'uncertainty'],
  causal: ['causal_design', 'confounders', 'identification'],
  experimental: ['run', 'controls', 'metric', 'reproducibility'],
  novelty: ['search_coverage', 'comparable_conditions', 'baseline'], hypothesis: ['falsification']
} as const;

/** Exact UTF-16 range within a captured evidence excerpt, including its source/parse identity. */
export const scientificEvidenceReferenceSchema = z.strictObject({
  evidenceId: id, sourceDigest: hash, start: z.number().int().nonnegative(),
  end: z.number().int().positive(), quote: z.string().min(1).max(12000)
}).refine(value => value.end > value.start, 'research_scientific_locator_invalid');
const references = scientificEvidenceReferenceSchema.array().max(100);
export const scientificSuggestionSchema = z.strictObject({
  claimId: id, claimVersion: z.number().int().positive(), claimHash: hash,
  claimKind: z.enum(scientificClaimKinds), researchType: z.enum(['review', 'method', 'experiment']),
  verdict: z.enum(['supports', 'contradicts', 'qualifies', 'insufficient']), rationale: note,
  supporting: references, counterevidence: references, negativeResults: references,
  alternativeExplanations: z.array(z.strictObject({explanation: note, references})).max(30),
  conditions: z.array(z.strictObject({
    criterion: id, status: z.enum(['met', 'missing', 'uncertain']), rationale: note, references
  })).max(30),
  limitations: note.array().max(30),
  coverage: z.strictObject({examinedEvidenceIds: id.array().max(1000), unexaminedReason: note.nullable(),
    conclusion: z.literal('absence_is_not_evidence_of_absence')})
}).superRefine((value, ctx) => {
  const required: readonly string[] = scientificCriteria[value.claimKind];
  if (new Set(value.conditions.map(item => item.criterion)).size !== value.conditions.length ||
      required.some(criterion => !value.conditions.some(item => item.criterion === criterion))) {
    ctx.addIssue({code: 'custom', message: 'research_scientific_conditions_required'});
  }
  if (value.conditions.some(item => item.status === 'met' && item.references.length === 0) ||
      (value.verdict === 'supports' && (value.supporting.length === 0 || value.claimKind === 'hypothesis' ||
        required.some(criterion => value.conditions.find(item => item.criterion === criterion)?.status !== 'met'))) ||
      (value.verdict === 'contradicts' && value.counterevidence.length === 0) ||
      (value.verdict === 'qualifies' && value.limitations.length === 0)) {
    ctx.addIssue({code: 'custom', message: 'research_scientific_evidence_conditions_missing'});
  }
});
export const scientificFindingSchema = z.strictObject({
  id, severity: z.enum(['fatal', 'major', 'minor']),
  category: z.enum(['fatal_flaw', 'method_fit', 'evidence_sufficiency', 'novelty_support', 'reproducibility', 'writing_integrity']),
  claimIds: id.array().min(1).max(200), references, observation: note, action: note, acceptance: note
});
export const scientificReviewOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('verifier'), inputHash: hash, suggestions: scientificSuggestionSchema.array().min(1).max(500)}),
  z.strictObject({kind: z.literal('reviewer'), inputHash: hash, findings: scientificFindingSchema.array().max(200),
    coveredClaimIds: id.array().min(1).max(500), noFindingsRationale: note.nullable()})
]);
export const scientificReviewInputSchema = z.strictObject({
  schemaVersion: z.literal(1), rulesVersion: z.string().min(1), projectId: id,
  manuscript: researchManuscriptSchema, claims: researchClaimSchema.array().min(1).max(500),
  evidence: researchInspectedEvidenceSchema.array().max(1000), relations: researchEvidenceRelationSchema.array().max(5000)
});
export const scientificReviewInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1), status: z.enum(['current', 'stale']), reasons: id.array(),
  authority: z.literal('model_suggestion_requires_human_review'),
  artifactId: id, manuscriptArtifactId: id, inputHash: hash, reportHash: hash, rulesVersion: id,
  producer: z.strictObject({taskId: id, runId: id, role: id, providerId: id, modelId: id,
    modelVersion: id.nullable(), skillHash: hash}),
  input: scientificReviewInputSchema, output: scientificReviewOutputSchema
});
export const scientificFindingLinkSchema = z.strictObject({
  artifactId: id, reportHash: hash, findingId: id,
  reverification: z.strictObject({artifactId: id, reportHash: hash}).nullable()
});
export type ScientificReviewInput = z.infer<typeof scientificReviewInputSchema>;
export type ScientificReviewOutput = z.infer<typeof scientificReviewOutputSchema>;
export type ScientificReviewInspection = z.infer<typeof scientificReviewInspectionSchema>;
export type ScientificEvidenceReference = z.infer<typeof scientificEvidenceReferenceSchema>;
