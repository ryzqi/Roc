import {z} from 'zod';
import {
  researchReviewQualityPlanCreateSchema,researchReviewQualityPlanInspectionSchema,
  researchReviewQualityPlanGetSchema,researchReviewQualityPlansListSchema,
  researchReviewQualityAssessmentSaveSchema,researchReviewQualityAssessmentGetSchema,researchReviewQualityAssessmentInspectionSchema
} from '../../../shared/schemas/research-review-quality';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewQualityPlanRepository} from './review-quality-plan-repository';
import type {ResearchReviewQualityAssessmentRepository} from './review-quality-assessment-repository';
const capabilities={
  createPlan:descriptor('research.reviewQuality.createPlan',researchReviewQualityPlanCreateSchema,researchReviewQualityPlanInspectionSchema),
  getPlan:descriptor('research.reviewQuality.getPlan',researchReviewQualityPlanGetSchema,researchReviewQualityPlanInspectionSchema.nullable()),
  plans:descriptor('research.reviewQuality.plans',researchReviewQualityPlansListSchema,researchReviewQualityPlanInspectionSchema.array()),
  saveAssessment:descriptor('research.reviewQuality.saveAssessment',researchReviewQualityAssessmentSaveSchema,researchReviewQualityAssessmentInspectionSchema),
  getAssessment:descriptor('research.reviewQuality.getAssessment',researchReviewQualityAssessmentGetSchema,researchReviewQualityAssessmentInspectionSchema.nullable()),
  assessmentHistory:descriptor('research.reviewQuality.assessmentHistory',researchReviewQualityAssessmentGetSchema,researchReviewQualityAssessmentInspectionSchema.array())
};
export const researchReviewQualityCapabilities=Object.values(capabilities);
export function registerResearchReviewQualityCapabilities(context:RocPluginContext,repository:ResearchReviewQualityPlanRepository,assessments:ResearchReviewQualityAssessmentRepository):void {
  function register<TInput,TOutput>(capability:CapabilityDescriptor<TInput,TOutput>,run:(request:TInput)=>TOutput|Promise<TOutput>):void {
    context.capabilities.register(context.pluginId,capability,async input=>{
      try{return await run(capability.inputSchema.parse(input));}catch(error){throwSystematicReviewError(error);}
    });
  }
  register(capabilities.createPlan,request=>repository.create(request,requireResearchHuman('research.reviewQuality.createPlan',request.projectId)));
  register(capabilities.getPlan,request=>repository.get(request));
  register(capabilities.plans,request=>repository.list(request));
  register(capabilities.saveAssessment,request=>assessments.save(request,requireResearchHuman('research.reviewQuality.saveAssessment',request.projectId)));
  register(capabilities.getAssessment,request=>assessments.get(request));
  register(capabilities.assessmentHistory,request=>assessments.history(request));
}
function descriptor<TInput,TOutput>(name:string,inputSchema:z.ZodType<TInput>,outputSchema:z.ZodType<TOutput>):CapabilityDescriptor<TInput,TOutput> {
  return {name,version:'1.0.0',inputSchema,outputSchema};
}
