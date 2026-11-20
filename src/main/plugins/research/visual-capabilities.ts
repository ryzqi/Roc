import type {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {getCapabilityAbortSignal} from '../../kernel/capability-cancellation';
import {visualProjectSchema, visualConfigSchema, visualSaveConfigSchema, visualIndexRequestSchema,
  visualIndexResultSchema, visualSearchRequestSchema, visualSearchResultSchema,
  visualInspectModelSchema, visualModelSchema} from '../../../shared/schemas/research-visual-retrieval';
import type {VisualIndexService} from './visual-index-service';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  config: descriptor('research.visual.config', visualProjectSchema, visualConfigSchema),
  inspectModel: descriptor('research.visual.inspectModel', visualInspectModelSchema, visualModelSchema),
  saveConfig: descriptor('research.visual.saveConfig', visualSaveConfigSchema, visualConfigSchema),
  rebuild: descriptor('research.visual.rebuild', visualIndexRequestSchema, visualIndexResultSchema),
  search: descriptor('research.visual.search', visualSearchRequestSchema, visualSearchResultSchema)
};
export const researchVisualCapabilities = Object.values(capabilities);
export function registerResearchVisualCapabilities(context: RocPluginContext, service: VisualIndexService): void {
  const signal = () => getCapabilityAbortSignal() ?? new AbortController().signal;
  context.capabilities.register(context.pluginId, capabilities.config, async input => service.readConfig(input.projectId));
  context.capabilities.register(context.pluginId, capabilities.inspectModel, input => service.inspectModel(input.projectId, input.model, signal()));
  context.capabilities.register(context.pluginId, capabilities.saveConfig, async input => service.saveConfig(input.projectId, input.config));
  context.capabilities.register(context.pluginId, capabilities.rebuild, input => service.rebuild(input, signal()));
  context.capabilities.register(context.pluginId, capabilities.search, input => service.search(input, signal()));
}
