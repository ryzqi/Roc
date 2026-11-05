import type { z } from 'zod';
import {
  researchPythonEnvironmentSelectSchema, researchPythonEnvironmentGetSchema, researchPythonEnvironmentListSchema,
  researchPythonEnvironmentSelectionSchema
} from '../../../shared/schemas/research-python-environments';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchPythonEnvironmentRepository } from './python-environment-repository';
import type { ResearchPythonEnvironmentService } from './python-environment-service';

const capabilities = {
  select: descriptor('research.pythonEnvironments.select', researchPythonEnvironmentSelectSchema, researchPythonEnvironmentSelectionSchema.nullable()),
  get: descriptor('research.pythonEnvironments.get', researchPythonEnvironmentGetSchema, researchPythonEnvironmentSelectionSchema),
  list: descriptor('research.pythonEnvironments.list', researchPythonEnvironmentListSchema, researchPythonEnvironmentSelectionSchema.array())
};
export const researchPythonEnvironmentCapabilities = Object.values(capabilities);

export function registerResearchPythonEnvironmentCapabilities(context: RocPluginContext, repository: ResearchPythonEnvironmentRepository,
  service: ResearchPythonEnvironmentService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, action: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async input => action(capability.inputSchema.parse(input)));
  }
  register(capabilities.select, request => service.select(request));
  register(capabilities.get, request => repository.get(request));
  register(capabilities.list, request => repository.list(request));
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
