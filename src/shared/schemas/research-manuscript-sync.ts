import {z} from 'zod';
import {researchExperimentPathSchema} from './research-experiments';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIds = id.array().max(100).refine(ids => new Set(ids).size === ids.length);
const paths = z.strictObject({
  texPath: researchExperimentPathSchema.refine(path => path.endsWith('.tex')),
  bibPath: researchExperimentPathSchema.refine(path => path.endsWith('.bib'))
});
export const researchManuscriptSyncInspectSchema = z.strictObject({projectId: id, artifactId: id});
export const researchManuscriptSyncAttachSchema = researchManuscriptSyncInspectSchema.extend({
  ...paths.shape, expectedArtifactVersion: hash, mode: z.enum(['checkout', 'existing'])
});
export const researchManuscriptSyncApplySchema = researchManuscriptSyncInspectSchema.extend({
  expectedPreviewHash: hash, requestId: id,
  changes: z.strictObject({id, evidenceIds}).array().min(1).max(500)
}).refine(request => new Set(request.changes.map(change => change.id)).size === request.changes.length);
export const researchManuscriptSyncInspectionSchema = researchManuscriptSyncInspectSchema.extend({
  artifactVersion: hash, binding: paths.nullable(), previewHash: hash, canApply: z.boolean(),
  status: z.enum(['unbound', 'current', 'changed', 'conflict']),
  changes: z.strictObject({id, kind: z.enum(['claim', 'section']), label: z.string(), before: z.string(), after: z.string(),
    claimId: id.nullable(), evidenceIds, citationKeys: id.array()}).array(),
  issues: z.string().array()
});

export type ResearchManuscriptSyncInspect = z.infer<typeof researchManuscriptSyncInspectSchema>;
export type ResearchManuscriptSyncAttach = z.infer<typeof researchManuscriptSyncAttachSchema>;
export type ResearchManuscriptSyncApply = z.infer<typeof researchManuscriptSyncApplySchema>;
export type ResearchManuscriptSyncInspection = z.infer<typeof researchManuscriptSyncInspectionSchema>;
