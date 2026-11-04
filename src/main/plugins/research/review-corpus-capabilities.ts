import {z} from 'zod';
import {
  researchReviewCorpusCreateSchema, researchReviewCorpusInspectionSchema, researchReviewCorpusGetSchema,
  researchReviewCorpusListSchema, researchReviewCorpusHitRequestSchema, researchReviewCorpusHitResultSchema
} from '../../../shared/schemas/research-review-corpus';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewCorpusRepository} from './review-corpus-repository';
const capabilities = {
  create: descriptor('research.reviewCorpus.create', researchReviewCorpusCreateSchema, researchReviewCorpusInspectionSchema),
  get: descriptor('research.reviewCorpus.get', researchReviewCorpusGetSchema, researchReviewCorpusInspectionSchema),
  list: descriptor('research.reviewCorpus.list', researchReviewCorpusListSchema, researchReviewCorpusInspectionSchema.array()),
  hit: descriptor('research.reviewCorpus.hit', researchReviewCorpusHitRequestSchema, researchReviewCorpusHitResultSchema)
};
export const researchReviewCorpusCapabilities = Object.values(capabilities);
export function registerResearchReviewCorpusCapabilities(context: RocPluginContext, repository: ResearchReviewCorpusRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return run(capability.inputSchema.parse(input));}
      catch (error) {throwSystematicReviewError(error);}
    });
  }
  register(capabilities.create, request => repository.create(request, requireResearchHuman('research.reviewCorpus.create', request.projectId)));
  register(capabilities.get, request => repository.get(request));
  register(capabilities.list, request => repository.list(request));
  register(capabilities.hit, request => repository.getHit(request));
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
