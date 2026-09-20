import type { z } from 'zod';

import {
  researchExportBundleRequestSchema,
  researchExportBundleSchema,
  researchManuscriptGetRequestSchema,
  researchManuscriptSaveRequestSchema,
  researchManuscriptSchema
} from '../../../shared/schemas/research-evidence';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchManuscriptRepository } from './manuscript-repository';

const capabilities = {
  saveManuscript: descriptor('research.manuscript.save', researchManuscriptSaveRequestSchema, researchManuscriptSchema),
  getManuscript: descriptor('research.manuscript.get', researchManuscriptGetRequestSchema, researchManuscriptSchema.nullable()),
  exportBundle: descriptor('research.manuscript.exportBundle', researchExportBundleRequestSchema, researchExportBundleSchema)
};

export const researchManuscriptCapabilities = Object.values(capabilities);

export function registerResearchManuscriptCapabilities(context: RocPluginContext, repository: ResearchManuscriptRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async (input) => run(capability.inputSchema.parse(input)));
  }
  register(capabilities.saveManuscript, (request) => repository.saveManuscript(request));
  register(capabilities.getManuscript, (request) => repository.getManuscript(request.artifactId));
  register(capabilities.exportBundle, (request) => repository.exportBundle(request));
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
