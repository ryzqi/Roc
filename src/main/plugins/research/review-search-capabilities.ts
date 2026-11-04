import {z} from 'zod';
import {
  researchReviewSearchStartSchema, researchReviewSearchGetSchema, researchReviewSearchListSchema,
  researchReviewSearchInspectionSchema, researchReviewSearchPoolRequestSchema, researchReviewSearchPoolResultSchema,
  researchReviewSearchCancelSchema
} from '../../../shared/schemas/research-review-search';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchReviewSearchService} from './review-search-service';
import {throwSystematicReviewError} from './systematic-review-capabilities';

const capabilities = {
  start: descriptor('research.reviewSearch.start', researchReviewSearchStartSchema, researchReviewSearchInspectionSchema),
  get: descriptor('research.reviewSearch.get', researchReviewSearchGetSchema, researchReviewSearchInspectionSchema),
  list: descriptor('research.reviewSearch.list', researchReviewSearchListSchema, researchReviewSearchInspectionSchema.array()),
  pool: descriptor('research.reviewSearch.pool', researchReviewSearchPoolRequestSchema, researchReviewSearchPoolResultSchema),
  cancel: descriptor('research.reviewSearch.cancel', researchReviewSearchCancelSchema, researchReviewSearchInspectionSchema)
};
export const researchReviewSearchCapabilities = Object.values(capabilities);
export function registerResearchReviewSearchCapabilities(context: RocPluginContext, service: ResearchReviewSearchService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return run(capability.inputSchema.parse(input));}
      catch (error) {throwSystematicReviewError(error);}
    });
  }
  register(capabilities.start, request => service.start(request, requireResearchHuman('research.reviewSearch.start', request.projectId)));
  register(capabilities.cancel, request => service.cancel(request, requireResearchHuman('research.reviewSearch.cancel', request.projectId)));
  register(capabilities.get, request => service.get(request));
  register(capabilities.list, request => service.list(request));
  register(capabilities.pool, request => service.readPool(request));
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
