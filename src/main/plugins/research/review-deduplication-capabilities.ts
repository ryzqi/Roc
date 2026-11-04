import {z} from 'zod';
import {
  researchReviewDuplicateSaveSchema, researchReviewDuplicateInspectionSchema, researchReviewDuplicateHistorySchema,
  researchReviewDeduplicationGetSchema, researchReviewDeduplicationFreezeSchema, researchReviewDeduplicationInspectionSchema
} from '../../../shared/schemas/research-review-deduplication';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewDeduplicationRepository} from './review-deduplication-repository';

const capabilities = {
  save: descriptor('research.reviewDeduplication.save', researchReviewDuplicateSaveSchema, researchReviewDuplicateInspectionSchema),
  history: descriptor('research.reviewDeduplication.history', researchReviewDuplicateHistorySchema, researchReviewDuplicateInspectionSchema.array()),
  get: descriptor('research.reviewDeduplication.get', researchReviewDeduplicationGetSchema, researchReviewDeduplicationInspectionSchema),
  freeze: descriptor('research.reviewDeduplication.freeze', researchReviewDeduplicationFreezeSchema, researchReviewDeduplicationInspectionSchema)
};
export const researchReviewDeduplicationCapabilities = Object.values(capabilities);
export function registerResearchReviewDeduplicationCapabilities(context: RocPluginContext, repository: ResearchReviewDeduplicationRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return run(capability.inputSchema.parse(input));}
      catch (error) {throwSystematicReviewError(error);}
    });
  }
  register(capabilities.save, request => repository.save(request, requireResearchHuman('research.reviewDeduplication.save', request.projectId)));
  register(capabilities.history, request => repository.history(request));
  register(capabilities.get, request => repository.get(request));
  register(capabilities.freeze, request => repository.freeze(request, requireResearchHuman('research.reviewDeduplication.freeze', request.projectId)));
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
