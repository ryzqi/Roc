import {z} from 'zod';
import {
  researchReviewQualityPlanCreateSchema,researchReviewQualityPlanInspectionSchema,
  researchReviewQualityPlanGetSchema,researchReviewQualityPlansListSchema
} from '../../../shared/schemas/research-review-quality';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewQualityPlanRepository} from './review-quality-plan-repository';
const capabilities={
  createPlan:descriptor('research.reviewQuality.createPlan',researchReviewQualityPlanCreateSchema,researchReviewQualityPlanInspectionSchema),
  getPlan:descriptor('research.reviewQuality.getPlan',researchReviewQualityPlanGetSchema,researchReviewQualityPlanInspectionSchema.nullable()),
  plans:descriptor('research.reviewQuality.plans',researchReviewQualityPlansListSchema,researchReviewQualityPlanInspectionSchema.array())
};
export const researchReviewQualityCapabilities=Object.values(capabilities);
export function registerResearchReviewQualityCapabilities(context:RocPluginContext,repository:ResearchReviewQualityPlanRepository):void {
  function register<TInput,TOutput>(capability:CapabilityDescriptor<TInput,TOutput>,run:(request:TInput)=>TOutput|Promise<TOutput>):void {
    context.capabilities.register(context.pluginId,capability,async input=>{
      try{return await run(capability.inputSchema.parse(input));}catch(error){throwSystematicReviewError(error);}
    });
  }
  register(capabilities.createPlan,request=>repository.create(request,requireResearchHuman('research.reviewQuality.createPlan',request.projectId)));
  register(capabilities.getPlan,request=>repository.get(request));
  register(capabilities.plans,request=>repository.list(request));
}
function descriptor<TInput,TOutput>(name:string,inputSchema:z.ZodType<TInput>,outputSchema:z.ZodType<TOutput>):CapabilityDescriptor<TInput,TOutput> {
  return {name,version:'1.0.0',inputSchema,outputSchema};
}
