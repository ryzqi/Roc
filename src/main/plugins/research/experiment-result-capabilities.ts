import type {z} from 'zod';
import {researchExperimentResultReviewSchema,researchExperimentResultGetSchema,researchExperimentResultListSchema,
  researchExperimentResultReceiptSchema,researchExperimentResultListResultSchema,
  researchExperimentCompareSchema,researchExperimentComparisonSchema} from '../../../shared/schemas/research-experiment-results';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import type {ResearchExperimentResultService} from './experiment-result-service';
import type {ResearchExperimentResultRepository} from './experiment-result-repository';

const capabilities={
  review:descriptor('research.experimentResults.review',researchExperimentResultReviewSchema,researchExperimentResultReceiptSchema),
  get:descriptor('research.experimentResults.get',researchExperimentResultGetSchema,researchExperimentResultReceiptSchema),
  list:descriptor('research.experimentResults.list',researchExperimentResultListSchema,researchExperimentResultListResultSchema),
  compare:descriptor('research.experimentResults.compare',researchExperimentCompareSchema,researchExperimentComparisonSchema)
};
export const researchExperimentResultCapabilities=Object.values(capabilities);
export function registerResearchExperimentResultCapabilities(context:RocPluginContext,repository:ResearchExperimentResultRepository,
  service:ResearchExperimentResultService):void {
  function register<I,O>(capability:CapabilityDescriptor<I,O>,action:(input:I)=>O|Promise<O>):void {
    context.capabilities.register(context.pluginId,capability,async input=>action(capability.inputSchema.parse(input)));
  }
  register(capabilities.review,request=>service.review(request));
  register(capabilities.get,request=>service.get(request));
  register(capabilities.list,request=>repository.list(request));
  register(capabilities.compare,request=>service.compare(request));
}
function descriptor<I,O>(name:string,inputSchema:z.ZodType<I>,outputSchema:z.ZodType<O>):CapabilityDescriptor<I,O> {
  return {name,version:'1.0.0',inputSchema,outputSchema};
}
