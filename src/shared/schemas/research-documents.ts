import { z } from 'zod';
import { researchCitationKeySchema } from './research-library';
import { researchParsedDocumentSchema, researchParseTiers } from './research-production';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchDocumentSchema = z.object({
  id: z.string(), libraryItemId: z.string(), filename: z.string(), mediaType: z.string(), sourceHash: hash,
  size: z.number().int().nonnegative(), status: z.enum(['imported', 'parsing', 'ready', 'failed', 'cancelled']),
  currentParseId: z.string().nullable(), activeParseId: z.string().nullable(), error: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string()
}).strict();
export const researchDocumentImportRequestSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('new-item'), sourcePath: z.string().min(1), title: z.string().trim().min(1).max(1000),
    citationKey: researchCitationKeySchema, projectId: z.string().min(1).nullable() }).strict(),
  z.object({ target: z.literal('library-item'), sourcePath: z.string().min(1), libraryItemId: z.string().min(1),
    projectId: z.string().min(1).nullable() }).strict()
]);
export const researchDocumentIdRequestSchema = z.object({ documentId: z.string().min(1) }).strict();
export const researchDocumentListRequestSchema = z.object({ libraryItemId: z.string().min(1) }).strict();
export const researchDocumentRunSchema = z.object({
  id: z.string(), documentId: z.string(), status: z.enum(['running', 'ready', 'failed', 'cancelled']),
  error: z.string().nullable(), createdAt: z.string(), finishedAt: z.string().nullable()
}).strict();
export const researchDocumentAssetSchema = z.object({
  id: z.string(), kind: z.enum(['page', 'figure', 'table']), page: z.number().int().positive().nullable(),
  sha256: hash, size: z.number().int().nonnegative()
}).strict();
export const researchDocumentContentSchema = researchParsedDocumentSchema.omit({ blocks: true, assets: true }).extend({
  blocks: z.array(researchParsedDocumentSchema.shape.blocks.element.omit({ imagePath: true }).extend({ imageAssetId: z.string().nullable() }).strict()),
  assets: z.array(researchDocumentAssetSchema)
}).strict();
export const researchDocumentParseSchema = z.object({ run: researchDocumentRunSchema, content: researchDocumentContentSchema }).strict();
export const researchDocumentParseRequestSchema = researchDocumentIdRequestSchema.extend({ parseId: z.string().min(1) }).strict();
/**
 * 发起解析。`tier` 为 null 时使用当前选中的模型档位；HTML 会由原生 DOM 解析器处理，不加载模型。只允许选档位，不开放 `pageRange`/`device`：它们是本地调试参数，不应成为持久 API。
 */
export const researchDocumentStartParseRequestSchema = researchDocumentIdRequestSchema.extend({
  tier: z.enum(researchParseTiers).nullable()
}).strict();
/**
 * 批量重解析（提案 §8.5「用户选择模型后，显式单篇/批量重解析」）。
 * `documentIds` 为 null 表示“全部待重解析的文档”（有原文、无当前结果），由后端枚举而不是
 * 前端拼一份可能已过期的列表。
 */
export const researchDocumentBatchParseRequestSchema = z.object({
  documentIds: z.array(z.string().min(1)).max(500).nullable(),
  tier: z.enum(researchParseTiers).nullable()
}).strict();
export const researchDocumentBatchParseSchema = z.object({
  documents: z.array(researchDocumentSchema), failed: z.array(z.object({ documentId: z.string(), error: z.string() }).strict())
}).strict();
export const researchDocumentSourceRequestSchema = researchDocumentIdRequestSchema.extend({ sourceHash: hash }).strict();
export const researchDocumentAssetRequestSchema = researchDocumentParseRequestSchema.extend({ assetId: z.string().min(1), sha256: hash }).strict();
