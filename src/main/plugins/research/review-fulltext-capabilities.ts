import {z} from 'zod';
import {
  researchReviewFullTextBindingSaveSchema,researchReviewFullTextBindingInspectionSchema,researchReviewFullTextBindingGetSchema,
  researchReviewFullTextBindingListSchema,researchReviewFullTextBindingsListSchema
} from '../../../shared/schemas/research-review-fulltext';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewFullTextRepository} from './review-fulltext-repository';
const capabilities={
  save:descriptor('research.reviewFullText.save',researchReviewFullTextBindingSaveSchema,researchReviewFullTextBindingInspectionSchema),
  get:descriptor('research.reviewFullText.get',researchReviewFullTextBindingGetSchema,researchReviewFullTextBindingInspectionSchema),
  list:descriptor('research.reviewFullText.list',researchReviewFullTextBindingsListSchema,researchReviewFullTextBindingInspectionSchema.array()),
  history:descriptor('research.reviewFullText.history',researchReviewFullTextBindingListSchema,researchReviewFullTextBindingInspectionSchema.array())
};
export const researchReviewFullTextCapabilities=Object.values(capabilities);
export function registerResearchReviewFullTextCapabilities(context:RocPluginContext,repository:ResearchReviewFullTextRepository):void {
  function register<TInput,TOutput>(capability:CapabilityDescriptor<TInput,TOutput>,run:(request:TInput)=>TOutput|Promise<TOutput>):void {
    context.capabilities.register(context.pluginId,capability,async input=>{
      try{return await run(capability.inputSchema.parse(input));}catch(error){throwSystematicReviewError(error);}
    });
  }
  register(capabilities.save,request=>repository.save(request,requireResearchHuman('research.reviewFullText.save',request.projectId)));
  register(capabilities.get,request=>repository.get(request));
  register(capabilities.list,request=>repository.list(request));
  register(capabilities.history,request=>repository.history(request));
}
function descriptor<TInput,TOutput>(name:string,inputSchema:z.ZodType<TInput>,outputSchema:z.ZodType<TOutput>):CapabilityDescriptor<TInput,TOutput> {
  return {name,version:'1.0.0',inputSchema,outputSchema};
}
