import { z } from 'zod';
import { researchTemplateCompileRequestSchema } from './research';

export const researchToolchainStatusSchema = z.object({
  available: z.boolean(),
  // 开放记录：工具集增加时（例如 vale）无需再动这张 schema，键集由 lock 的 architectures 决定。
  versions: z.record(z.string(), z.string()).nullable(),
  error: z.string().nullable()
}).strict();

/** 用户可选的模型配置包（提案 §5）。`advanced` 复用 `standard` 的权重，不另下 VLM。 */
export const researchModelPacks = ['basic', 'standard', 'advanced', 'flash'] as const;
export type ResearchModelPack = (typeof researchModelPacks)[number];
/** 下载源。`auto` 由官方入口按可达性选择；具体落到哪个源由清单与官方 CLI 决定。 */
export const researchModelSources = ['auto', 'huggingface', 'modelscope'] as const;
export type ResearchModelSource = (typeof researchModelSources)[number];
/** 单个模型仓库的状态（提案 §5「模型状态」）。 */
export const researchModelStates = ['missing', 'downloading', 'verifying', 'ready', 'incompatible', 'failed'] as const;
export type ResearchModelState = (typeof researchModelStates)[number];

/**
 * 一个配置包的可见状态。
 *
 * `bytes` 是该包需要的总字节数（清单里的精确值），`installedBytes` 是**已经通过校验**
 * 的仓库字节数——两者相减才是还需要下载的量，不能用目录大小糊弄。
 */
export const researchModelPackStatusSchema = z.object({
  pack: z.enum(researchModelPacks),
  ready: z.boolean(),
  bytes: z.number().int().nonnegative(),
  installedBytes: z.number().int().nonnegative(),
  state: z.enum(researchModelStates),
  error: z.string().nullable(),
  models: z.array(z.string())
}).strict();

/**
 * 下载/校验任务。`bytesDone`/`bytesTotal` 是真实字节进度：任务总量来自清单，
 * 已完成量来自已经落盘的文件，而不是估算的百分比。
 */
export const researchModelJobSchema = z.object({
  pack: z.enum(researchModelPacks),
  source: z.enum(researchModelSources),
  phase: z.enum(['downloading', 'verifying']),
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
  startedAt: z.string()
}).strict();

export const researchModelsStatusSchema = z.object({
  ready: z.boolean(),
  downloading: z.boolean(),
  error: z.string().nullable(),
  /** 当前选中的配置包；解析的默认档位跟着它走。 */
  selectedPack: z.enum(researchModelPacks),
  source: z.enum(researchModelSources),
  /** 正在进行的任务（没有任务时为 null）。 */
  job: researchModelJobSchema.nullable(),
  /** 每个包各自的就绪与占用，用于设置页并排比较（含未选中的包）。 */
  packs: z.array(researchModelPackStatusSchema),
  models: z.array(z.object({
    name: z.string(),
    kind: z.enum(['torch', 'gguf']),
    ready: z.boolean(),
    bytes: z.number().int().nonnegative(),
    error: z.string().nullable()
  }).strict())
}).strict();

export const researchModelsSelectRequestSchema = z.object({
  pack: z.enum(researchModelPacks),
  /** 省略时保留已选源：选中一个包不应默默把用户选的镜像改回 `auto`。 */
  source: z.enum(researchModelSources).optional()
}).strict();
export const researchModelsDownloadRequestSchema = z.object({
  pack: z.enum(researchModelPacks),
  source: z.enum(researchModelSources)
}).strict();
/** 导入用户已经下载好的模型目录：只读源目录，复制到 staging 校验后发布。 */
export const researchModelsImportRequestSchema = z.object({ directory: z.string().min(1).max(4000) }).strict();
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

/** 结果代际与协议身份：只保留一版实现，旧代际由数据库标记拦截而不是反序列化。 */
export const researchParseContractVersion = 2;

/** 档位与冻结选项：worker 与主进程共用一份定义，不各自猜默认值。 */
export const researchParseTiers = ['basic', 'standard', 'advanced', 'flash'] as const;
export const researchParseOptionsSchema = z.object({
  tier: z.enum(researchParseTiers),
  smallBackend: z.literal('torch'),
  // 非 VLM 档位只能是 `auto`：MinerU 配置的 enum 不接受空串，也不会实例化引擎。
  vlmEngine: z.enum(['auto', 'llama-cpp', 'mlx']),
  device: z.enum(['mps', 'cpu']),
  // 空串 = 全文档；非空空值如 `1-5`。
  pageRange: z.string().max(64),
  ocrMode: z.enum(['auto', 'txt', 'ocr'])
}).strict();
export type ResearchParseOptions = z.infer<typeof researchParseOptionsSchema>;
export type ResearchParseTier = (typeof researchParseTiers)[number];

export const researchParsedDocumentSchema = z.object({
  // —— 协议身份（提案 §7）——
  contractVersion: z.literal(researchParseContractVersion),
  engine: z.literal('mineru'), engineVersion: z.string(), adapterVersion: z.string(),
  parserVersion: z.string(), parserFingerprint: hash,
  // 空串表示本次没有模型参与（flash 档）。
  modelManifest: z.union([hash, z.literal('')]),
  runtime: z.record(z.string(), z.string()),
  tier: z.enum(researchParseTiers),
  reportedTier: z.string(), parseMode: z.string().nullable(),
  device: z.enum(['mps', 'cpu']),
  // —— 结果 ——
  sourceHash: hash,
  pageCount: z.number().int().nonnegative(), content: z.string(),
  blocks: z.array(z.object({
    id: z.string(), kind: z.enum(['heading', 'paragraph', 'table', 'figure', 'formula']), label: z.string(), text: z.string(),
    locator: z.string(), imagePath: z.string().nullable(),
    locations: z.array(z.object({ page: z.number().int().positive(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      coordinateOrigin: z.enum(['TOPLEFT', 'BOTTOMLEFT']) }).strict())
  }).strict()),
  assets: z.array(z.object({ path: z.string(), kind: z.enum(['page', 'figure', 'table']), page: z.number().int().positive().nullable() }).strict()),
  // 工件相对路径：middle_json / markdown 独立保存，不与 content 混用。
  artifacts: z.object({ middleJson: z.string(), markdown: z.string(), structuredContent: z.string() }).strict(),
  warnings: z.array(z.string())
}).strict();

export const researchRenderedPdfSchema = z.object({
  path: z.string(), page: z.number().int().positive(), pageCount: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(), text: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
