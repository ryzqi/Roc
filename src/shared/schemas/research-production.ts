import { z } from 'zod';
import { researchTemplateCompileRequestSchema } from './research';

export const researchToolchainStatusSchema = z.object({
  available: z.boolean(),
  // 开放记录：工具集增加时（例如 vale）无需再动这张 schema，键集由 lock 的 architectures 决定。
  versions: z.record(z.string(), z.string()).nullable(),
  error: z.string().nullable()
}).strict();

export const researchModelPacks = ['compact', 'complete'] as const;
export type ResearchModelPack = (typeof researchModelPacks)[number];
export const researchModelKinds = ['onnx', 'dictionary', 'tokenizer'] as const;
export type ResearchModelKind = (typeof researchModelKinds)[number];
export const researchModelStates = ['missing', 'downloading', 'verifying', 'importing', 'ready', 'incompatible', 'failed'] as const;
export type ResearchModelState = (typeof researchModelStates)[number];

export const researchModelPackStatusSchema = z.object({
  pack: z.enum(researchModelPacks),
  ready: z.boolean(),
  bytes: z.number().int().nonnegative(),
  installedBytes: z.number().int().nonnegative(),
  state: z.enum(researchModelStates),
  error: z.string().nullable(),
  models: z.array(z.string())
}).strict();

export const researchModelJobSchema = z.object({
  pack: z.enum(researchModelPacks),
  phase: z.enum(['downloading', 'verifying', 'importing']),
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
  startedAt: z.string()
}).strict();

export const researchModelsStatusSchema = z.object({
  ready: z.boolean(),
  downloading: z.boolean(),
  error: z.string().nullable(),
  selectedPack: z.enum(researchModelPacks),
  job: researchModelJobSchema.nullable(),
  packs: z.array(researchModelPackStatusSchema),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(researchModelKinds),
    ready: z.boolean(),
    bytes: z.number().int().nonnegative(),
    error: z.string().nullable()
  }).strict())
}).strict();

export const researchModelsSelectRequestSchema = z.object({ pack: z.enum(researchModelPacks) }).strict();
export const researchModelsDownloadRequestSchema = z.object({ pack: z.enum(researchModelPacks) }).strict();
export const researchModelsImportRequestSchema = z.object({
  directory: z.string().min(1).max(4000),
  pack: z.enum(researchModelPacks)
}).strict();
export const researchModelsRemoveRequestSchema = z.object({ pack: z.enum(researchModelPacks) }).strict();

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

const hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const researchDocumentLimits = {
  maxBlocks: 100_000,
  maxAssets: 5_000,
  maxAssetBytes: 64 * 1024 * 1024,
  maxTotalAssetBytes: 512 * 1024 * 1024,
  maxArtifactBytes: 128 * 1024 * 1024
} as const;

export const researchParseContractVersion = 3;
export const researchParserVersion = 'roc-research-parser/2' as const;
export const researchParseTiers = researchModelPacks;
export const researchParseOptionsSchema = z.object({
  tier: z.enum(researchParseTiers),
  device: z.enum(['coreml', 'cpu']),
  pageRange: z.string().max(64)
}).strict();
export type ResearchParseOptions = z.infer<typeof researchParseOptionsSchema>;
export type ResearchParseTier = (typeof researchParseTiers)[number];

export const researchParsedDocumentSchema = z.object({
  contractVersion: z.literal(researchParseContractVersion),
  engine: z.literal('paddleocr.js'),
  engineVersion: z.string(),
  parserVersion: z.string(),
  parserFingerprint: hash,
  modelManifest: z.union([hash, z.literal('')]),
  runtime: z.record(z.string(), z.string()),
  tier: z.enum(researchParseTiers),
  parseMode: z.enum(['ocr', 'native-text', 'mixed', 'html']),
  device: z.enum(['coreml', 'cpu']),
  sourceHash: hash,
  pageCount: z.number().int().nonnegative(),
  content: z.string(),
  blocks: z.array(z.object({
    id: z.string(), kind: z.enum(['heading', 'paragraph', 'table', 'figure', 'formula']), label: z.string(), text: z.string(),
    locator: z.string(), imagePath: z.string().nullable(),
    locations: z.array(z.object({ page: z.number().int().positive(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      coordinateOrigin: z.enum(['TOPLEFT', 'BOTTOMLEFT']) }).strict())
  }).strict()).max(researchDocumentLimits.maxBlocks),
  assets: z.array(z.object({ path: z.string(), kind: z.enum(['page', 'figure', 'table']), page: z.number().int().positive().nullable() }).strict())
    .max(researchDocumentLimits.maxAssets),
  artifacts: z.object({ middleJson: z.string(), markdown: z.string(), structuredContent: z.string() }).strict(),
  warnings: z.array(z.string())
}).strict();


export const researchRenderedPdfSchema = z.object({
  path: z.string(), page: z.number().int().positive(), pageCount: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(), text: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
