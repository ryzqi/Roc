import {researchReviewReportGetSchema,researchReviewReportInspectionSchema} from '../../../shared/schemas/research-review-report';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewReportService} from './review-report-service';
export const researchReviewReportCapability:CapabilityDescriptor=
  {name:'research.reviewReport.get',version:'1.0.0',inputSchema:researchReviewReportGetSchema,outputSchema:researchReviewReportInspectionSchema};
export function registerResearchReviewReportCapability(context:RocPluginContext,service:ResearchReviewReportService):void {
  context.capabilities.register(context.pluginId,researchReviewReportCapability,async input=>{
    try{return service.get(researchReviewReportGetSchema.parse(input));}catch(error){throwSystematicReviewError(error);}
  });
}
