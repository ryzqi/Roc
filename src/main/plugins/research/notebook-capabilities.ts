import type { z } from 'zod';
import {
  researchNotebookFileRequestSchema, researchNotebookImportRequestSchema, researchNotebookGetRequestSchema,
  researchNotebookListRequestSchema, researchNotebookPreviewSchema, researchNotebookImportedSchema,
  researchNotebookListResultSchema
} from '../../../shared/schemas/research-notebooks';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchNotebookRepository } from './notebook-repository';

const capabilities = {
  preview: descriptor('research.notebooks.preview', researchNotebookFileRequestSchema, researchNotebookPreviewSchema),
  import: descriptor('research.notebooks.import', researchNotebookImportRequestSchema, researchNotebookImportedSchema),
  get: descriptor('research.notebooks.get', researchNotebookGetRequestSchema, researchNotebookImportedSchema),
  list: descriptor('research.notebooks.list', researchNotebookListRequestSchema, researchNotebookListResultSchema)
};
export const researchNotebookCapabilities = Object.values(capabilities);
export function registerResearchNotebookCapabilities(context: RocPluginContext, repository: ResearchNotebookRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, action: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async input => action(capability.inputSchema.parse(input)));
  }
  register(capabilities.preview, request => repository.preview(request));
  register(capabilities.import, request => repository.import(request));
  register(capabilities.get, request => repository.get(request));
  register(capabilities.list, request => repository.list(request));
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
