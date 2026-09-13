import { z } from 'zod';
import { researchExportDeliverySchema, researchExportExecutionSchema, researchExportFileContentSchema, researchExportIdRequestSchema,
  researchExportListRequestSchema, researchExportPrepareSchema, researchExportPublishRequestSchema, researchExportReadRequestSchema,
  researchExportSourceRequestSchema, researchExportWriteRequestSchema } from '../../../shared/schemas/research-exports';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchExportRepository } from './export-repository';
import type { ResearchExportService } from './export-service';

const capabilities = {
  prepare: descriptor('research.export.prepare', researchExportPrepareSchema, researchExportExecutionSchema),
  get: descriptor('research.export.get', researchExportIdRequestSchema, researchExportExecutionSchema),
  list: descriptor('research.export.list', researchExportListRequestSchema, researchExportExecutionSchema.array()),
  cancel: descriptor('research.export.cancel', researchExportIdRequestSchema, researchExportExecutionSchema),
  publish: descriptor('research.export.publish', researchExportPublishRequestSchema, researchExportExecutionSchema),
  read: descriptor('research.export.read', researchExportReadRequestSchema, researchExportFileContentSchema),
  write: descriptor('research.export.write', researchExportWriteRequestSchema, researchExportDeliverySchema),
  source: descriptor('research.export.source', researchExportSourceRequestSchema, z.unknown())
};
export const researchExportCapabilities = Object.values(capabilities);

export function registerResearchExportCapabilities(context: RocPluginContext, repository: ResearchExportRepository, service: ResearchExportService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => await run(capability.inputSchema.parse(input)));
  }
  register(capabilities.prepare, (input) => service.prepare(input));
  register(capabilities.get, (input) => repository.get(input.projectId, input.exportId));
  register(capabilities.list, (input) => repository.list(input.projectId, input.limit));
  register(capabilities.cancel, (input) => service.cancel(input.projectId, input.exportId));
  register(capabilities.publish, (input) => service.publish(input.projectId, input.exportId, input.replacesExportId));
  register(capabilities.read, (input) => service.read(input.projectId, input.exportId, input.path));
  register(capabilities.write, (input) => service.write(input));
  register(capabilities.source, async (input) => {
    const bytes = await service.source(input.projectId, input.exportId, input.sha256);
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'content-disposition': 'inline; filename="paper.pdf"' } });
  });
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
