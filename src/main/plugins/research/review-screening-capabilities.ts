import {z} from 'zod';
import {
  researchReviewScreeningPlanCreateSchema, researchReviewScreeningPlanGetSchema, researchReviewScreeningPlanInspectionSchema
} from '../../../shared/schemas/research-review-screening';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewScreeningRepository} from './review-screening-repository';

const capabilities = {
  createPlan: descriptor('research.reviewScreening.createPlan', researchReviewScreeningPlanCreateSchema, researchReviewScreeningPlanInspectionSchema),
  getPlan: descriptor('research.reviewScreening.getPlan', researchReviewScreeningPlanGetSchema, researchReviewScreeningPlanInspectionSchema)
};
export const researchReviewScreeningCapabilities = Object.values(capabilities);
export function registerResearchReviewScreeningCapabilities(context: RocPluginContext, repository: ResearchReviewScreeningRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return run(capability.inputSchema.parse(input));}
      catch (error) {throwSystematicReviewError(error);}
    });
  }
  register(capabilities.createPlan, request => repository.createPlan(request, requireResearchHuman('research.reviewScreening.createPlan', request.projectId)));
  register(capabilities.getPlan, request => repository.getPlan(request));
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
