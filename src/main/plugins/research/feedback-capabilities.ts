import {researchFeedbackImportSchema,researchFeedbackInspectionSchema,researchFeedbackGetSchema,researchFeedbackListSchema,
  researchFeedbackListResultSchema,researchFeedbackMergeSchema,researchFeedbackMergeReceiptSchema} from '../../../shared/schemas/research-feedback';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchFeedbackService} from './feedback-service';

const version='1.0.0';
const capabilities={
  import:{name:'research.feedback.import',version,inputSchema:researchFeedbackImportSchema,outputSchema:researchFeedbackInspectionSchema},
  get:{name:'research.feedback.get',version,inputSchema:researchFeedbackGetSchema,outputSchema:researchFeedbackInspectionSchema},
  list:{name:'research.feedback.list',version,inputSchema:researchFeedbackListSchema,outputSchema:researchFeedbackListResultSchema},
  merge:{name:'research.feedback.merge',version,inputSchema:researchFeedbackMergeSchema,outputSchema:researchFeedbackMergeReceiptSchema}
};
export const researchFeedbackCapabilities=Object.values(capabilities);
export function registerResearchFeedbackCapabilities(context:RocPluginContext,service:ResearchFeedbackService):void{
  context.capabilities.register(context.pluginId,capabilities.import,input=>service.import(input));
  context.capabilities.register(context.pluginId,capabilities.get,input=>service.get(input));
  context.capabilities.register(context.pluginId,capabilities.list,input=>service.list(input));
  context.capabilities.register(context.pluginId,capabilities.merge,input=>service.merge(input));
}
