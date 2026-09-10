import { z } from 'zod';

const identifier = z.string().trim().min(1);
const evidenceIds = z.array(identifier).max(100).refine((ids) => new Set(ids).size === ids.length, 'Evidence IDs must be unique.');

export const researchEvidenceSchema = z.object({
  id: identifier,
  projectId: identifier,
  documentId: identifier,
  chunkId: identifier,
  sourceType: z.enum(['literature', 'file', 'experiment']),
  sourceId: identifier,
  sourceVersion: identifier,
  title: identifier,
  locator: identifier,
  excerpt: z.string().min(1).refine((text) => text.trim().length > 0, 'Evidence excerpt must not be blank.'),
  contentHash: identifier,
  createdAt: identifier
}).strict();

export const researchEvidenceCaptureRequestSchema = z.object({ projectId: identifier, chunkId: identifier }).strict();
export const researchEvidenceListRequestSchema = z.object({ projectId: identifier }).strict();

export const researchClaimSchema = z.object({
  id: identifier,
  projectId: identifier,
  artifactId: identifier,
  subjectType: z.enum(['claim', 'paragraph', 'figure']),
  content: z.string().trim().min(1).max(20000),
  status: z.enum(['supported', 'hypothesis', 'pending']),
  evidenceIds,
  version: z.number().int().positive(),
  createdAt: identifier,
  updatedAt: identifier
}).strict();

export const researchClaimCreateRequestSchema = researchClaimSchema.omit({ id: true, version: true, createdAt: true, updatedAt: true }).strict();
export const researchClaimUpdateRequestSchema = researchClaimSchema.pick({ id: true, content: true, status: true, evidenceIds: true })
  .extend({ expectedVersion: z.number().int().positive() }).strict();
export const researchClaimHistoryRequestSchema = z.object({ id: identifier }).strict();
export const researchClaimListRequestSchema = z.object({ projectId: identifier, artifactId: identifier.optional() }).strict();

export const researchManuscriptSectionSchema = z.object({
  title: z.string().trim().min(1).max(300),
  claimIds: z.array(identifier).min(1).max(500)
}).strict();

export const researchManuscriptSaveRequestSchema = z.object({
  artifactId: identifier,
  sections: z.array(researchManuscriptSectionSchema).min(1).max(100)
}).strict().refine((request) => {
  const ids = request.sections.flatMap((section) => section.claimIds);
  return new Set(ids).size === ids.length;
}, 'Each paragraph must appear only once.');

export const researchManuscriptGetRequestSchema = z.object({ artifactId: identifier }).strict();

export const researchManuscriptSchema = z.object({
  artifactId: identifier,
  projectId: identifier,
  sections: z.array(researchManuscriptSectionSchema),
  latex: z.string().min(1),
  contentHash: identifier,
  claimsHash: identifier,
  updatedAt: identifier
}).strict();

export const researchExportBundleRequestSchema = z.object({ projectId: identifier, artifactId: identifier }).strict();
export const researchExportBundleSchema = z.object({
  projectId: identifier,
  artifactId: identifier,
  manuscript: researchManuscriptSchema,
  claims: z.array(researchClaimSchema),
  evidence: z.array(researchEvidenceSchema),
  generatedAt: identifier
}).strict();
