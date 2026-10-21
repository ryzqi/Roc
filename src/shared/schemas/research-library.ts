import { z } from 'zod';
import { researchLiteratureSchema } from './research';

export const researchBibliographyFormatSchema = z.enum(['bibtex', 'biblatex', 'csl-json']);
export const researchCitationKeySchema = z.string().min(1).max(500).regex(/^[^\s,{}\\%#"]+$/u);
export const researchBibliographyEntrySchema = z.object({
  citationKey: researchCitationKeySchema, entryType: z.string().min(1).max(100),
  fields: z.record(z.string(), z.string()), preambles: z.array(z.string()), csl: z.record(z.string(), z.json()).nullable(),
  title: z.string().trim().min(1), authors: z.array(z.string()), doi: z.string().nullable(),
  publishedYear: z.number().int().nullable(), abstract: z.string().nullable(), url: z.string().nullable()
}).strict();

export const researchLibraryItemSchema = z.object({
  id: z.string(), metadata: researchLiteratureSchema, bibliography: researchBibliographyEntrySchema,
  sources: z.array(z.object({ metadata: researchLiteratureSchema, bibliography: researchBibliographyEntrySchema }).strict()), projectIds: z.array(z.string()),
  revision: z.number().int().positive(), archived: z.boolean(), createdAt: z.string(), updatedAt: z.string()
}).strict();
export const researchLibraryListRequestSchema = z.object({
  projectId: z.string().min(1).nullable(), query: z.string().max(1000), includeArchived: z.boolean(),
  limit: z.number().int().min(1).max(500)
}).strict();
export const researchLibraryIdRequestSchema = z.object({ id: z.string().min(1) }).strict();
export const researchLibraryDoiImportRequestSchema = z.object({
  doi: z.string().trim().min(1).max(2000), projectId: z.string().min(1).nullable()
}).strict();
export const researchLibraryRecordImportRequestSchema = z.object({
  record: researchLiteratureSchema, citationKey: researchCitationKeySchema, projectId: z.string().min(1).nullable()
}).strict();
export const researchLibraryFileImportRequestSchema = z.object({
  sourcePath: z.string().min(1), format: researchBibliographyFormatSchema, projectId: z.string().min(1).nullable()
}).strict();
export const researchLibraryImportResultSchema = z.object({
  items: z.array(researchLibraryItemSchema), createdCount: z.number().int().nonnegative(), duplicateCount: z.number().int().nonnegative()
}).strict();
export const researchLibraryExportRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(5000), format: researchBibliographyFormatSchema
}).strict();
export const researchLibraryExportSchema = z.object({ format: researchBibliographyFormatSchema, filename: z.string(), content: z.string() }).strict();
export const researchLibraryLinkRequestSchema = z.object({ id: z.string().min(1), projectId: z.string().min(1), linked: z.boolean() }).strict();
export const researchLibraryArchiveRequestSchema = z.object({ id: z.string().min(1), expectedRevision: z.number().int().positive(), archived: z.boolean() }).strict();
export const researchLibraryCitationKeyRequestSchema = z.object({
  id: z.string().min(1), expectedRevision: z.number().int().positive(), citationKey: researchCitationKeySchema
}).strict();

/**
 * 撤稿核查（`retraction-check.ts`）。
 *
 * 结论只有三档，且 `unknown` **不是**「正常」：查不到/没 DOI/网络失败都落在这里，
 * 界面与助手必须把它显示成「没查到」。`checkedAt` 是结论的一部分（这是核查时点的快照）。
 */
export const researchLibraryRetractionRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50)
}).strict();
export const researchLibraryRetractionSchema = z.object({
  id: z.string().min(1), citationKey: researchCitationKeySchema, doi: z.string().nullable(),
  status: z.enum(['retracted', 'clear', 'unknown']), checkedSource: z.literal('openalex'),
  detail: z.string().nullable(), checkedAt: z.string()
}).strict();
export const researchLibraryRetractionResultSchema = z.object({ results: z.array(researchLibraryRetractionSchema) }).strict();
