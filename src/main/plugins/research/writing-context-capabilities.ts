import type {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {getCapabilityAbortSignal} from '../../kernel/capability-cancellation';
import {prepareWritingContextRequestSchema, writingContextRequestSchema, writingContextResultSchema,
  writingGroundingResultSchema, writingImpactResultSchema} from '../../../shared/schemas/research-writing-context';
import type {WritingContextService} from './writing-context-service';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  prepare: descriptor('research.writing.prepareContext', prepareWritingContextRequestSchema, writingContextResultSchema),
  check: descriptor('research.writing.checkGrounding', writingContextRequestSchema, writingGroundingResultSchema),
  impact: descriptor('research.writing.reviewImpact', writingContextRequestSchema, writingImpactResultSchema)
};
export const researchWritingContextCapabilities = Object.values(capabilities);
export function registerResearchWritingContextCapabilities(context: RocPluginContext, service: WritingContextService): void {
  context.capabilities.register(context.pluginId, capabilities.prepare, input => service.prepare(input, getCapabilityAbortSignal()));
  context.capabilities.register(context.pluginId, capabilities.check, input => service.checkGrounding(input, getCapabilityAbortSignal()));
  context.capabilities.register(context.pluginId, capabilities.impact, input => service.reviewImpact(input, getCapabilityAbortSignal()));
}
