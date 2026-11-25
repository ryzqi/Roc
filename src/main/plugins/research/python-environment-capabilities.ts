import type { z } from 'zod';
import {
  researchPythonEnvironmentPrepareSchema, researchPythonEnvironmentGetSchema, researchPythonEnvironmentListSchema,
  researchPythonEnvironmentReceiptSchema, researchPythonEnvironmentStatusSchema, researchPythonEnvironmentOperationSchema, researchPythonEnvironmentCancelSchema
} from '../../../shared/schemas/research-python-environments';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchPythonEnvironmentRepository } from './python-environment-repository';
import type { ResearchPythonEnvironmentService } from './python-environment-service';

const capabilities = {
  prepare: descriptor('research.pythonEnvironments.prepare', researchPythonEnvironmentPrepareSchema, researchPythonEnvironmentOperationSchema),
  status: descriptor('research.pythonEnvironments.status', researchPythonEnvironmentListSchema, researchPythonEnvironmentStatusSchema),
  cancel: descriptor('research.pythonEnvironments.cancel', researchPythonEnvironmentCancelSchema, researchPythonEnvironmentOperationSchema),
  get: descriptor('research.pythonEnvironments.get', researchPythonEnvironmentGetSchema, researchPythonEnvironmentReceiptSchema),
  list: descriptor('research.pythonEnvironments.list', researchPythonEnvironmentListSchema, researchPythonEnvironmentReceiptSchema.array())
};
export const researchPythonEnvironmentCapabilities = Object.values(capabilities);

export function registerResearchPythonEnvironmentCapabilities(context: RocPluginContext, repository: ResearchPythonEnvironmentRepository,
  service: ResearchPythonEnvironmentService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, action: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async input => action(input));
  }
  register(capabilities.prepare, request => service.prepare(request));
  register(capabilities.status, request => service.status(request));
  register(capabilities.cancel, request => service.cancel(request));
  register(capabilities.get, request => repository.get(request));
  register(capabilities.list, request => service.list(request));
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
