import {z} from 'zod';
import {researchJournalProfileSchema} from './research-journal-compliance';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchExperimentPathSchema} from './research-experiments';
const id = z.string().trim().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchSubmissionRequirementsSchema = z.strictObject({
  maximumPages: z.number().int().min(1).max(5000).nullable(), anonymous: z.boolean(),
  requiredDeclarations: z.string().trim().min(1).max(1000).array().max(100),
  minimumEditableTables: z.number().int().nonnegative().max(1000),
  supplementPaths: researchExperimentPathSchema.array().max(100)
}).refine(value => new Set(value.requiredDeclarations).size === value.requiredDeclarations.length &&
  new Set(value.supplementPaths).size === value.supplementPaths.length, 'research_submission_requirements_duplicate');
export const researchSubmissionProfileSaveSchema = z.strictObject({
  projectId: id, requestId: id, profileId: id.nullable(), parent: z.strictObject({versionId: id, versionHash: hash}).nullable(),
  profile: researchJournalProfileSchema, requirements: researchSubmissionRequirementsSchema
}).refine(value => (value.profileId === null) === (value.parent === null), 'research_submission_profile_parent_required');
export const researchSubmissionProfileReceiptSchema = z.strictObject({
  snapshot: z.strictObject({schemaVersion: z.literal(1), id, profileId: id, version: z.number().int().positive(),
    request: researchSubmissionProfileSaveSchema, requestHash: hash, actor: researchRelationReviewerSchema, recordedAt: z.string().datetime()}), snapshotHash: hash
});
export const researchSubmissionProfileGetSchema = z.strictObject({projectId: id, versionId: id, expectedHash: hash});
export const researchSubmissionProfileListSchema = z.strictObject({projectId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)});
export const researchSubmissionProfileCompareSchema = z.strictObject({projectId: id,
  left: z.strictObject({versionId: id, expectedHash: hash}), right: z.strictObject({versionId: id, expectedHash: hash})});
export const researchSubmissionProfileDifferenceSchema = z.strictObject({addedRuleIds: id.array(), removedRuleIds: id.array(),
  changedRuleIds: id.array(), changedRequirementKeys: z.enum(['maximumPages', 'anonymous', 'requiredDeclarations', 'minimumEditableTables', 'supplementPaths']).array()});
export const researchSubmissionProfileListResultSchema = z.strictObject({items: researchSubmissionProfileReceiptSchema.array(), total: z.number().int().nonnegative()});
export const researchSubmissionPreflightSchema = z.strictObject({
  profile: z.strictObject({versionId: id, expectedHash: hash}),
  files: z.strictObject({subjectId: z.string().min(1), sha256: hash, size: z.number().int().nonnegative()}).array(),
  pdf: z.strictObject({sha256: hash, size: z.number().int().positive(), pages: z.number().int().positive(), readableText: z.boolean()}),
  checks: z.strictObject({kind: z.enum(['journal_rules', 'pages', 'declarations', 'anonymity', 'editable_tables', 'supplements']),
    status: z.enum(['pass', 'fail', 'manual']), subjectIds: z.string().min(1).array(), detail: z.string().min(1)}).array(),
  status: z.enum(['pass', 'fail', 'manual']), reportHash: hash
});
export type ResearchSubmissionProfileSave = z.infer<typeof researchSubmissionProfileSaveSchema>;
export type ResearchSubmissionProfileGet = z.infer<typeof researchSubmissionProfileGetSchema>;
export type ResearchSubmissionProfileList = z.infer<typeof researchSubmissionProfileListSchema>;
export type ResearchSubmissionProfileListResult = z.infer<typeof researchSubmissionProfileListResultSchema>;
export type ResearchSubmissionProfileReceipt = z.infer<typeof researchSubmissionProfileReceiptSchema>;
export type ResearchSubmissionPreflight = z.infer<typeof researchSubmissionPreflightSchema>;

export type ResearchSubmissionProfileCompare = z.infer<typeof researchSubmissionProfileCompareSchema>;
export type ResearchSubmissionProfileDifference = z.infer<typeof researchSubmissionProfileDifferenceSchema>;
