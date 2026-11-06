import {z} from 'zod';
import {zenodoInputsRequestSchema, zenodoInputsSchema, zenodoPrepareSchema, zenodoPreparedSchema, zenodoReadSchema,
  zenodoListSchema, zenodoListResultSchema} from '../../../shared/schemas/research-zenodo';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import type {ZenodoPreparationService} from './zenodo-preparation';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  inputs: descriptor('research.zenodo.inputs', zenodoInputsRequestSchema, zenodoInputsSchema),
  prepare: descriptor('research.zenodo.prepare', zenodoPrepareSchema, zenodoPreparedSchema),
  get: descriptor('research.zenodo.getPreparation', zenodoReadSchema, zenodoPreparedSchema),
  list: descriptor('research.zenodo.listPreparations', zenodoListSchema, zenodoListResultSchema)
};
export const researchZenodoCapabilities = Object.values(capabilities);
export function registerResearchZenodoCapabilities(context: RocPluginContext, service: ZenodoPreparationService): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => run(capability.inputSchema.parse(input)));
  }
  register(capabilities.inputs, input => service.inputs(input));
  register(capabilities.prepare, input => service.prepare(input));
  register(capabilities.get, input => service.get(input.projectId, input.preparationId));
  register(capabilities.list, input => service.list(input));
}
