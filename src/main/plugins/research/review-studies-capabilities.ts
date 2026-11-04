import {z} from 'zod';
import {researchReviewStudiesSaveSchema,researchReviewStudiesGetSchema,researchReviewStudiesInspectionSchema} from '../../../shared/schemas/research-review-studies';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewStudiesRepository} from './review-studies-repository';
const capabilities={
  save:descriptor('research.reviewStudies.save',researchReviewStudiesSaveSchema,researchReviewStudiesInspectionSchema),
  get:descriptor('research.reviewStudies.get',researchReviewStudiesGetSchema,researchReviewStudiesInspectionSchema.nullable()),
  history:descriptor('research.reviewStudies.history',researchReviewStudiesGetSchema,researchReviewStudiesInspectionSchema.array())
};
export const researchReviewStudiesCapabilities=Object.values(capabilities);
export function registerResearchReviewStudiesCapabilities(context:RocPluginContext,repository:ResearchReviewStudiesRepository):void {
  function register<TInput,TOutput>(capability:CapabilityDescriptor<TInput,TOutput>,run:(request:TInput)=>TOutput|Promise<TOutput>):void {
    context.capabilities.register(context.pluginId,capability,async input=>{
      try{return await run(capability.inputSchema.parse(input));}catch(error){throwSystematicReviewError(error);}
    });
  }
  register(capabilities.save,request=>repository.save(request,requireResearchHuman('research.reviewStudies.save',request.projectId)));
  register(capabilities.get,request=>repository.get(request));
  register(capabilities.history,request=>repository.history(request));
}
function descriptor<TInput,TOutput>(name:string,inputSchema:z.ZodType<TInput>,outputSchema:z.ZodType<TOutput>):CapabilityDescriptor<TInput,TOutput> {
  return {name,version:'1.0.0',inputSchema,outputSchema};
}
