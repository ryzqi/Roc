import type { z } from 'zod';
import { researchProductionInputContentSchema, researchProductionInputReadSchema, researchProductionInputRequestSchema,
  researchProductionInputSchema } from '../../../shared/schemas/research-production-inputs';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchProductionInputService } from './production-input-service';

const inspect = descriptor('research.artifacts.inspectProduction', researchProductionInputRequestSchema, researchProductionInputSchema);
const read = descriptor('research.artifacts.readProductionFile', researchProductionInputReadSchema, researchProductionInputContentSchema);
export const researchProductionInputCapabilities = [inspect, read];

export function registerResearchProductionInputCapabilities(context: RocPluginContext, service: ResearchProductionInputService): void {
  context.capabilities.register(context.pluginId, inspect, async (value) => {
    const input = inspect.inputSchema.parse(value);
    return await service.inspect(input.projectId, input.artifactId);
  });
  context.capabilities.register(context.pluginId, read, async (value) => await service.read(read.inputSchema.parse(value)));
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
