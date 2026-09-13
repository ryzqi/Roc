import { z } from 'zod';
import { researchArtifactSchema, researchProvenanceSchema } from './research';
import { researchClaimSchema, researchEvidenceSchema, researchManuscriptSchema } from './research-evidence';
import { researchExperimentExecutionSchema, researchExperimentPathSchema } from './research-experiments';
import { researchFigurePublicationSchema } from './research-figures';
import { researchBibliographyEntrySchema, researchCitationKeySchema } from './research-library';
import { researchReviewCycleSchema, researchStageRunSchema } from './research-runs';

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchExportFileSchema = z.object({ path: researchExperimentPathSchema, sha256: digest, size: z.number().int().nonnegative() }).strict();
export const researchExportTemplateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default'), language: z.enum(['zh', 'en']) }).strict(),
  z.object({ kind: z.literal('imported'), templateId: id, expectedRevision: z.number().int().positive(), expectedSourceDigest: digest }).strict()
]);
export const researchExportPrepareSchema = z.object({
  projectId: id, requestId: id.max(128), title: z.string().trim().min(1).max(256), manuscriptArtifactId: id,
  figureIds: z.array(id).max(100).refine((ids) => new Set(ids).size === ids.length), template: researchExportTemplateSchema
}).strict();
export const researchExportSourcesSchema = z.object({
  project: z.object({ id, title: z.string(), description: z.string(), workspacePath: z.string().nullable() }).strict(),
  manuscriptArtifact: researchArtifactSchema, manuscript: researchManuscriptSchema,
  claims: z.array(researchClaimSchema), evidence: z.array(researchEvidenceSchema), figures: z.array(researchFigurePublicationSchema),
  bibliography: z.array(researchBibliographyEntrySchema), libraryRevisions: z.array(z.object({ id, revision: z.number().int().positive() }).strict()),
  citationKeys: z.record(id, researchCitationKeySchema),
  provenance: z.array(researchProvenanceSchema), modelRuns: z.array(researchStageRunSchema), experiments: z.array(researchExperimentExecutionSchema),
  evidenceMetadata: z.record(id, z.record(z.string(), z.json()).nullable()), review: researchReviewCycleSchema,
  template: z.object({ id, revision: z.number().int().positive(), entryPath: researchExperimentPathSchema,
    sourceDigest: digest, files: z.array(researchExportFileSchema) }).strict().nullable()
}).strict();
export const researchExportExecutionSchema = z.object({
  id, projectId: id, request: researchExportPrepareSchema,
  status: z.enum(['preparing', 'ready', 'failed', 'cancelled', 'interrupted']),
  sources: researchExportSourcesSchema.nullable(), sourceHash: digest.nullable(), toolchainHash: digest.nullable(),
  files: z.array(researchExportFileSchema), archive: researchExportFileSchema.nullable(),
  artifactId: id.nullable(), approval: z.enum(['unpublished', 'draft', 'approved', 'superseded']), replacesExportId: id.nullable(),
  error: z.string().nullable(), createdAt: z.string(), endedAt: z.string().nullable()
}).strict();
export const researchExportIdRequestSchema = z.object({ projectId: id, exportId: id }).strict();
export const researchExportListRequestSchema = z.object({ projectId: id, limit: z.number().int().min(1).max(200) }).strict();
export const researchExportPublishRequestSchema = researchExportIdRequestSchema.extend({ replacesExportId: id.nullable() }).strict();
export const researchExportSourceRequestSchema = researchExportIdRequestSchema.extend({ sha256: digest }).strict();
export const researchExportReadRequestSchema = researchExportIdRequestSchema.extend({ path: researchExperimentPathSchema }).strict();
export const researchExportFileContentSchema = z.object({ file: researchExportFileSchema, content: z.string(), encoding: z.enum(['utf8', 'base64']) }).strict();
export const researchExportWriteRequestSchema = researchExportIdRequestSchema.extend({
  destinationPath: z.string().min(1).max(4096).refine((path) => path.startsWith('/') && path.endsWith('.zip') && !/[\u0000-\u001f]/u.test(path))
}).strict();
export const researchExportDeliverySchema = z.object({ exportId: id, projectId: id, destinationPath: z.string(), sha256: digest, size: z.number().int().positive(), createdAt: z.string() }).strict();

export type ResearchExportPrepare = z.infer<typeof researchExportPrepareSchema>;
export type ResearchExportSources = z.infer<typeof researchExportSourcesSchema>;
export type ResearchExportExecution = z.infer<typeof researchExportExecutionSchema>;
export type ResearchExportFile = z.infer<typeof researchExportFileSchema>;
export type ResearchExportDelivery = z.infer<typeof researchExportDeliverySchema>;
