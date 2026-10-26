import { z } from 'zod';
import { researchTemplateCompileRequestSchema, researchTemplateImportRequestSchema, researchTemplateSchema } from '../../../shared/schemas/research';
import {
  researchTemplateEntryRequestSchema, researchTemplateFileContentSchema, researchTemplateFileRequestSchema,
  researchTemplateFileSaveRequestSchema, researchTemplateFileSchema, researchTemplateListRequestSchema,
  researchTemplatePreviewRequestSchema, researchToolchainStatusSchema, researchModelsStatusSchema,
  researchModelsSelectRequestSchema, researchModelsDownloadRequestSchema, researchModelsImportRequestSchema,
  researchModelsRemoveRequestSchema
} from '../../../shared/schemas/research-production';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { ResearchTemplateService } from './template-service';
import type { ResearchToolchain } from './toolchain';

const capabilities = {
  status: descriptor('research.toolchain.status', z.object({}).strict(), researchToolchainStatusSchema),
  modelsStatus: descriptor('research.models.status', z.object({}).strict(), researchModelsStatusSchema),
  modelsSelect: descriptor('research.models.select', researchModelsSelectRequestSchema, researchModelsStatusSchema),
  modelsDownload: descriptor('research.models.download', researchModelsDownloadRequestSchema, researchModelsStatusSchema),
  modelsImport: descriptor('research.models.import', researchModelsImportRequestSchema, researchModelsStatusSchema),
  modelsRemove: descriptor('research.models.remove', researchModelsRemoveRequestSchema, researchModelsStatusSchema),
  modelsCancel: descriptor('research.models.cancel', z.object({}).strict(), researchModelsStatusSchema),
  import: descriptor('research.template.import', researchTemplateImportRequestSchema, researchTemplateSchema),
  compile: descriptor('research.template.compile', researchTemplateCompileRequestSchema, researchTemplateSchema),
  get: descriptor('research.template.get', researchTemplateCompileRequestSchema, researchTemplateSchema),
  list: descriptor('research.template.list', researchTemplateListRequestSchema, researchTemplateSchema.array()),
  files: descriptor('research.template.files', researchTemplateCompileRequestSchema, researchTemplateFileSchema.array()),
  read: descriptor('research.template.readFile', researchTemplateFileRequestSchema, researchTemplateFileContentSchema),
  save: descriptor('research.template.saveFile', researchTemplateFileSaveRequestSchema, researchTemplateFileContentSchema),
  entry: descriptor('research.template.setEntry', researchTemplateEntryRequestSchema, researchTemplateSchema),
  cancel: descriptor('research.template.cancel', researchTemplateCompileRequestSchema, researchTemplateSchema),
  preview: descriptor('research.template.preview', researchTemplatePreviewRequestSchema, z.unknown())
};
export const researchProductionCapabilities = Object.values(capabilities);

export function registerResearchProductionCapabilities(context: RocPluginContext, templates: ResearchTemplateService, tools: ResearchToolchain): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      return await run(capability.inputSchema.parse(input));
    });
  }
  function registerModels<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      try { return await run(capability.inputSchema.parse(input)); }
      catch (error) { throw mapResearchModelError(error); }
    });
  }
  register(capabilities.status, () => tools.status());
  registerModels(capabilities.modelsStatus, () => tools.modelsStatus());
  registerModels(capabilities.modelsSelect, (input) => tools.selectModels(input.pack));
  registerModels(capabilities.modelsDownload, (input) => tools.downloadModels(input.pack));
  registerModels(capabilities.modelsImport, (input) => tools.importModels(input.directory, input.pack));
  registerModels(capabilities.modelsRemove, (input) => tools.removeModels(input.pack));
  registerModels(capabilities.modelsCancel, () => tools.cancelModelsDownload());
  register(capabilities.import, (input) => templates.importTemplate(input));
  register(capabilities.compile, (input) => templates.compile(input));
  register(capabilities.get, (input) => templates.get(input));
  register(capabilities.list, (input) => templates.list(input.projectId));
  register(capabilities.files, (input) => templates.files(input));
  register(capabilities.read, (input) => templates.readFile(input));
  register(capabilities.save, (input) => templates.saveFile(input));
  register(capabilities.entry, (input) => templates.setEntry(input));
  register(capabilities.cancel, (input) => templates.cancel(input));
  register(capabilities.preview, async (input) => {
    const bytes = await templates.pdf(input);
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } });
  });
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}

const MODEL_ERROR_MESSAGES: Readonly<Record<string, { message: string; category: RocDomainError['category']; retryable: boolean }>> = {
  research_models_unavailable: { message: '解析模型尚未下载，请先在科研工作台下载。', category: 'degraded', retryable: false },
  research_model_download_locked: { message: '已有模型下载任务在进行，请等待完成或取消它。', category: 'conflict', retryable: false },
  research_model_downloader_unavailable: { message: '模型下载入口不可用：工具链尚未就绪。', category: 'degraded', retryable: false },
  research_model_import_missing: { message: '指定目录不存在。', category: 'validation', retryable: false },
  research_model_import_invalid: { message: '指定路径不是目录。', category: 'validation', retryable: false },
  research_model_import_empty: { message: '所选模型包所需的文件不完整或校验未通过。', category: 'validation', retryable: false },
  research_model_import_path_invalid: { message: '请选择绝对路径。', category: 'validation', retryable: false },
  // 取消是用户意图，不能当失败报：UI 上它是终态，不是错误。
  research_process_cancelled: { message: '模型下载已取消，已下载的文件保留，可重新发起续传。', category: 'conflict', retryable: false }
};

function mapResearchModelError(error: unknown): never {
  if (error instanceof RocDomainError) throw error;
  const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
  const known = MODEL_ERROR_MESSAGES[code];
  if (known !== undefined) throw new RocDomainError({ code, ...known });
  if (code.startsWith('research_model_') || code.startsWith('research_download_')) {
    // 具体失败原因（`research_model_missing:<repo>/<file>`）留在 code 里，UI 才能指向确实缺的文件。
    throw new RocDomainError({
      code,
      message: '解析模型下载或校验失败，请检查网络与磁盘后重试。',
      category: 'external',
      retryable: true
    });
  }
  throw error;
}
