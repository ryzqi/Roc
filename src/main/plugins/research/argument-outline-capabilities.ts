import {
  researchArgumentOutlineInspectSchema, researchArgumentOutlineInspectionSchema,
  researchArgumentOutlineSaveSchema, researchArgumentOutlineReceiptSchema,
  researchArgumentOutlineHistorySchema, researchArgumentOutlineHistoryResultSchema,
  researchArgumentOutlineMaterializeSchema, researchArgumentOutlineMaterializedSchema
} from '../../../shared/schemas/research-argument-outline';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchArgumentOutlineService} from './argument-outline-service';

const version = '1.0.0';
const capabilities = {
  inspect: {name:'research.argumentOutlines.inspect',version,inputSchema:researchArgumentOutlineInspectSchema,outputSchema:researchArgumentOutlineInspectionSchema},
  save: {name:'research.argumentOutlines.save',version,inputSchema:researchArgumentOutlineSaveSchema,outputSchema:researchArgumentOutlineReceiptSchema},
  history: {name:'research.argumentOutlines.history',version,inputSchema:researchArgumentOutlineHistorySchema,outputSchema:researchArgumentOutlineHistoryResultSchema},
  materialize: {name:'research.argumentOutlines.materialize',version,inputSchema:researchArgumentOutlineMaterializeSchema,outputSchema:researchArgumentOutlineMaterializedSchema}
};
export const researchArgumentOutlineCapabilities = Object.values(capabilities);
export function registerResearchArgumentOutlineCapabilities(context:RocPluginContext,service:ResearchArgumentOutlineService):void {
  context.capabilities.register(context.pluginId,capabilities.inspect,async input=>service.inspect(input));
  context.capabilities.register(context.pluginId,capabilities.save,async input=>service.save(input));
  context.capabilities.register(context.pluginId,capabilities.history,async input=>service.history(input));
  context.capabilities.register(context.pluginId,capabilities.materialize,async input=>service.materialize(input));
}
