import { z } from 'zod';
import { researchTemplateCompileRequestSchema } from './research';

export const researchToolchainStatusSchema = z.object({
  available: z.boolean(),
  versions: z.object({ python: z.string(), uv: z.string(), tectonic: z.string() }).strict().nullable(),
  error: z.string().nullable()
}).strict();

export const researchModelsStatusSchema = z.object({
  ready: z.boolean(),
  downloading: z.boolean(),
  error: z.string().nullable(),
  models: z.array(z.object({
    directory: z.string(),
    repoId: z.string(),
    ready: z.boolean()
  }).strict())
}).strict();

export const researchTemplateListRequestSchema = z.object({ projectId: z.string().min(1) }).strict();
export const researchTemplateFileSchema = z.object({
  path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), editable: z.boolean()
}).strict();
export const researchTemplateFileContentSchema = researchTemplateFileSchema.extend({ content: z.string() }).strict();
export const researchTemplateFileRequestSchema = researchTemplateCompileRequestSchema.extend({ path: z.string().min(1).max(1000) }).strict();
export const researchTemplateFileSaveRequestSchema = researchTemplateFileRequestSchema.extend({
  content: z.string().max(1024 * 1024), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable()
}).strict();
export const researchTemplateEntryRequestSchema = researchTemplateCompileRequestSchema.extend({
  entryPath: z.string().min(1).max(1000), expectedRevision: z.number().int().positive()
}).strict();
export const researchTemplatePreviewRequestSchema = researchTemplateCompileRequestSchema.extend({
  pdfHash: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export const researchParsedDocumentSchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), parserVersion: z.string(),
  pageCount: z.number().int().nonnegative(), content: z.string(),
  blocks: z.array(z.object({
    id: z.string(), kind: z.enum(['heading', 'paragraph', 'table', 'figure', 'formula']), label: z.string(), text: z.string(),
    locator: z.string(), imagePath: z.string().nullable(),
    locations: z.array(z.object({ page: z.number().int().positive(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      coordinateOrigin: z.enum(['TOPLEFT', 'BOTTOMLEFT']) }).strict())
  }).strict()),
  assets: z.array(z.object({ path: z.string(), kind: z.enum(['page', 'figure', 'table']), page: z.number().int().positive().nullable() }).strict()),
  warnings: z.array(z.string())
}).strict();

export const researchRenderedPdfSchema = z.object({
  path: z.string(), page: z.number().int().positive(), pageCount: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(), text: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
