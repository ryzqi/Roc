import {researchSubmissionPrepareSchema,researchSubmissionReceiptSchema,researchSubmissionGetSchema,researchSubmissionListSchema,
  researchSubmissionListResultSchema,researchSubmissionDeliverSchema,researchSubmissionDeliverySchema} from '../../../shared/schemas/research-submission';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchSubmissionService} from './submission-service';

const version='1.0.0';
const capabilities={
  prepare:{name:'research.submissions.prepare',version,inputSchema:researchSubmissionPrepareSchema,outputSchema:researchSubmissionReceiptSchema},
  get:{name:'research.submissions.get',version,inputSchema:researchSubmissionGetSchema,outputSchema:researchSubmissionReceiptSchema},
  list:{name:'research.submissions.list',version,inputSchema:researchSubmissionListSchema,outputSchema:researchSubmissionListResultSchema},
  deliver:{name:'research.submissions.deliver',version,inputSchema:researchSubmissionDeliverSchema,outputSchema:researchSubmissionDeliverySchema}
};
export const researchSubmissionCapabilities=Object.values(capabilities);
export function registerResearchSubmissionCapabilities(context:RocPluginContext,service:ResearchSubmissionService):void{
  context.capabilities.register(context.pluginId,capabilities.prepare,input=>service.prepare(input));
  context.capabilities.register(context.pluginId,capabilities.get,async input=>service.get(input));
  context.capabilities.register(context.pluginId,capabilities.list,async input=>service.list(input));
  context.capabilities.register(context.pluginId,capabilities.deliver,input=>service.deliver(input));
}
