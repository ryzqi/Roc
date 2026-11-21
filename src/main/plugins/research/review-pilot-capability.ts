import {researchReviewPilotRequestSchema,researchReviewPilotReportSchema} from '../../../shared/schemas/research-review-pilot';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchReviewExtractionPilot} from './review-extraction-pilot';

export const researchReviewPilotCapability = {name:'research.reviewExtraction.pilot',version:'1.0.0',
  inputSchema:researchReviewPilotRequestSchema,outputSchema:researchReviewPilotReportSchema};
export function registerResearchReviewPilotCapability(context:RocPluginContext,service:ResearchReviewExtractionPilot):void {
  context.capabilities.register(context.pluginId,researchReviewPilotCapability,input=>service.inspect(input));
}
