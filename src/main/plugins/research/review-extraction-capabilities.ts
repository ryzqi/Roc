import {z} from 'zod';
import {
  researchReviewExtractionSaveSchema,researchReviewExtractionInspectionSchema,
  researchReviewExtractionGetSchema,researchReviewExtractionHistorySchema,researchReviewExtractionListSchema
} from '../../../shared/schemas/research-review-extraction';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewExtractionRepository} from './review-extraction-repository';
const capabilities={
  save:descriptor('research.reviewExtraction.save',researchReviewExtractionSaveSchema,researchReviewExtractionInspectionSchema),
  get:descriptor('research.reviewExtraction.get',researchReviewExtractionGetSchema,researchReviewExtractionInspectionSchema),
  list:descriptor('research.reviewExtraction.list',researchReviewExtractionListSchema,researchReviewExtractionInspectionSchema.array()),
  history:descriptor('research.reviewExtraction.history',researchReviewExtractionHistorySchema,researchReviewExtractionInspectionSchema.array())
};
export const researchReviewExtractionCapabilities=Object.values(capabilities);
export function registerResearchReviewExtractionCapabilities(context:RocPluginContext,repository:ResearchReviewExtractionRepository):void {
  function register<TInput,TOutput>(capability:CapabilityDescriptor<TInput,TOutput>,run:(request:TInput)=>TOutput|Promise<TOutput>):void {
    context.capabilities.register(context.pluginId,capability,async input=>{
      try{return await run(capability.inputSchema.parse(input));}catch(error){throwSystematicReviewError(error);}
    });
  }
  register(capabilities.save,request=>repository.save(request,requireResearchHuman('research.reviewExtraction.save',request.projectId)));
  register(capabilities.get,request=>repository.get(request));
  register(capabilities.list,request=>repository.list(request));
  register(capabilities.history,request=>repository.history(request));
}
function descriptor<TInput,TOutput>(name:string,inputSchema:z.ZodType<TInput>,outputSchema:z.ZodType<TOutput>):CapabilityDescriptor<TInput,TOutput> {
  return {name,version:'1.0.0',inputSchema,outputSchema};
}
