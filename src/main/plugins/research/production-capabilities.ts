import { z } from 'zod';
import { researchTemplateCompileRequestSchema, researchTemplateImportRequestSchema, researchTemplateSchema } from '../../../shared/schemas/research';
import {
  researchTemplateEntryRequestSchema, researchTemplateFileContentSchema, researchTemplateFileRequestSchema,
  researchTemplateFileSaveRequestSchema, researchTemplateFileSchema, researchTemplateListRequestSchema,
  researchTemplatePreviewRequestSchema, researchToolchainStatusSchema
} from '../../../shared/schemas/research-production';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchTemplateService } from './template-service';
import type { ResearchToolchain } from './toolchain';

const capabilities = {
  status: descriptor('research.toolchain.status', z.object({}).strict(), researchToolchainStatusSchema),
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
    context.capabilities.register(context.pluginId, capability, async (input) => await run(capability.inputSchema.parse(input)));
  }
  register(capabilities.status, () => tools.status());
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
