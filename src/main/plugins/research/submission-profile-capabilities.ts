import {researchSubmissionProfileSaveSchema,researchSubmissionProfileReceiptSchema,researchSubmissionProfileGetSchema,
  researchSubmissionProfileListSchema,researchSubmissionProfileListResultSchema,researchSubmissionProfileCompareSchema,
  researchSubmissionProfileDifferenceSchema} from '../../../shared/schemas/research-submission-profile';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchSubmissionProfileService} from './submission-profile-service';

const version='1.0.0';
const capabilities={
  save:{name:'research.submissionProfiles.save',version,inputSchema:researchSubmissionProfileSaveSchema,outputSchema:researchSubmissionProfileReceiptSchema},
  get:{name:'research.submissionProfiles.get',version,inputSchema:researchSubmissionProfileGetSchema,outputSchema:researchSubmissionProfileReceiptSchema},
  list:{name:'research.submissionProfiles.list',version,inputSchema:researchSubmissionProfileListSchema,outputSchema:researchSubmissionProfileListResultSchema},
  compare:{name:'research.submissionProfiles.compare',version,inputSchema:researchSubmissionProfileCompareSchema,outputSchema:researchSubmissionProfileDifferenceSchema}
};
export const researchSubmissionProfileCapabilities=Object.values(capabilities);
export function registerResearchSubmissionProfileCapabilities(context:RocPluginContext,service:ResearchSubmissionProfileService):void{
  context.capabilities.register(context.pluginId,capabilities.save,async input=>service.save(input));
  context.capabilities.register(context.pluginId,capabilities.get,async input=>service.get(input));
  context.capabilities.register(context.pluginId,capabilities.list,async input=>service.list(input));
  context.capabilities.register(context.pluginId,capabilities.compare,async input=>service.compare(input));
}
