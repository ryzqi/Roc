import { z } from 'zod';
import { researchTemplateCompileRequestSchema, researchTemplateImportRequestSchema, researchTemplateSchema } from '../../../shared/schemas/research';
import {
  researchTemplateEntryRequestSchema, researchTemplateFileContentSchema, researchTemplateFileRequestSchema,
  researchTemplateFileSaveRequestSchema, researchTemplateFileSchema, researchTemplateListRequestSchema,
  researchTemplatePreviewRequestSchema, researchToolchainStatusSchema, researchModelsStatusSchema
} from '../../../shared/schemas/research-production';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { ResearchTemplateService } from './template-service';
import type { ResearchToolchain } from './toolchain';

const capabilities = {
  status: descriptor('research.toolchain.status', z.object({}).strict(), researchToolchainStatusSchema),
  modelsStatus: descriptor('research.models.status', z.object({}).strict(), researchModelsStatusSchema),
  modelsDownload: descriptor('research.models.download', z.object({}).strict(), researchModelsStatusSchema),
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
  registerModels(capabilities.modelsDownload, () => tools.downloadModels());
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

function mapResearchModelError(error: unknown): never {
  if (error instanceof RocDomainError) throw error;
  const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
  if (code === 'research_models_unavailable') {
    throw new RocDomainError({
      code,
      message: '解析模型尚未下载，请先在科研工作台下载。',
      category: 'degraded',
      retryable: false
    });
  }
  if (code.startsWith('research_model_') || code.startsWith('research_download_')) {
    throw new RocDomainError({
      code,
      message: '解析模型下载失败，请检查网络后重试。',
      category: 'external',
      retryable: true
    });
  }
  throw error;
}
