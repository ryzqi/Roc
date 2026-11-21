import {z} from 'zod';
import {researchExperimentPathSchema} from './research-experiments';
import {researchExportFileSchema} from './research-export-file';
import {researchSubmissionPreflightSchema} from './research-submission-profile';

const id = z.string().trim().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const profile = z.strictObject({versionId: id, expectedHash: hash});
export const researchSubmissionPrepareSchema = z.strictObject({
  projectId: id, exportId: id, expectedSourceHash: hash, profile, requestId: id,
  mode: z.enum(['named', 'anonymous']), title: z.string().trim().min(1).max(300),
  replacements: z.strictObject({find: z.string().trim().min(2).max(500), replace: z.string().trim().min(1).max(500)}).array().max(100),
  supplementPaths: researchExperimentPathSchema.array().max(100)
}).refine(input => new Set(input.replacements.map(rule => rule.find)).size === input.replacements.length &&
  new Set(input.supplementPaths).size === input.supplementPaths.length && (input.mode === 'anonymous' || input.replacements.length === 0))
  .refine(input => input.replacements.every(rule => !/^[\d\s.,+%−-]+$/u.test(rule.find) &&
    JSON.stringify(rule.find.match(/\d+/gu) ?? []) === JSON.stringify(rule.replace.match(/\d+/gu) ?? [])), 'research_submission_numeric_replacement_denied');
export const researchSubmissionGetSchema = z.strictObject({projectId: id, submissionId: id});
export const researchSubmissionListSchema = z.strictObject({projectId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)});
export const researchSubmissionRecordSchema = z.strictObject({
  id, projectId: id, exportId: id, sourceHash: hash, profile, mode: z.enum(['named', 'anonymous']),
  status: z.enum(['preparing', 'ready', 'failed', 'interrupted']), files: researchExportFileSchema.array(), archive: researchExportFileSchema.nullable(),
  preflight: researchSubmissionPreflightSchema.nullable(), manualReviewRequired: z.boolean(),
  journalChecks: z.strictObject({ruleId: id, status: z.enum(['pass', 'fail', 'manual'])}).array(),
  error: z.string().nullable(), createdAt: z.string().datetime(), endedAt: z.string().datetime().nullable()
});
export const researchSubmissionReceiptSchema = z.strictObject({record: researchSubmissionRecordSchema, recordHash: hash});
export const researchSubmissionListResultSchema = z.strictObject({items: researchSubmissionReceiptSchema.array(), total: z.number().int().nonnegative()});
export const researchSubmissionDeliverSchema = researchSubmissionGetSchema.extend({
  expectedHash: hash, destinationPath: z.string().min(1).max(4096)
    .refine(path => path.startsWith('/') && path.endsWith('.zip') && !/[\u0000-\u001f]/u.test(path)),
  manualReviewNote: z.string().trim().min(1).max(4000).nullable()
});
export const researchSubmissionDeliverySchema = z.strictObject({
  submissionId: id, projectId: id, destinationPath: z.string(), sha256: hash, size: z.number().int().positive(), createdAt: z.string().datetime()
});
export type ResearchSubmissionPrepare = z.infer<typeof researchSubmissionPrepareSchema>;
export type ResearchSubmissionGet = z.infer<typeof researchSubmissionGetSchema>;
export type ResearchSubmissionList = z.infer<typeof researchSubmissionListSchema>;
export type ResearchSubmissionReceipt = z.infer<typeof researchSubmissionReceiptSchema>;
export type ResearchSubmissionRecord = z.infer<typeof researchSubmissionRecordSchema>;
export type ResearchSubmissionDeliver = z.infer<typeof researchSubmissionDeliverSchema>;
export type ResearchSubmissionDelivery = z.infer<typeof researchSubmissionDeliverySchema>;

/** Parent metadata is never a submission supplement; explicit scientific data/code may be selected. */
export function isSubmissionExtraPath(path: string): boolean {
  return researchExperimentPathSchema.safeParse(path).success &&
    !['manifest.json', 'ro-crate-metadata.json', 'ro-crate-profile.html', 'paper.pdf'].includes(path) &&
    !path.startsWith('logs/') && !/\.(?:tex|bib|bbl|sty|cls)$/iu.test(path) &&
    (!path.startsWith('provenance/') || /^provenance\/experiments\/[^/]+\/(?:input|output)\//u.test(path));
}
