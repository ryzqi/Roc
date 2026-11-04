import {z} from 'zod';
import {
  researchReviewFullTextDecisionSaveSchema,researchReviewFullTextDecisionInspectionSchema,researchReviewFullTextDecisionHistorySchema,
  researchReviewFullTextSuggestionCreateSchema,researchReviewFullTextSuggestionInspectionSchema,researchReviewFullTextSuggestionListSchema,
  researchReviewFullTextPhaseGetSchema,researchReviewFullTextFrozenPhaseSchema,researchReviewFullTextFreezeRequestSchema,
  researchReviewFullTextArbitrationSaveSchema,researchReviewFullTextArbitrationInspectionSchema,researchReviewFullTextArbitrationHistorySchema
} from '../../../shared/schemas/research-review-fulltext-screening';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewFullTextScreening} from './review-fulltext-screening';
import type {ResearchReviewFullTextArbitration} from './review-fulltext-arbitration';
import type {ResearchReviewFullTextFreeze} from './review-fulltext-freeze';
const capabilities={
  save:descriptor('research.reviewFullTextScreening.save',researchReviewFullTextDecisionSaveSchema,researchReviewFullTextDecisionInspectionSchema),
  history:descriptor('research.reviewFullTextScreening.history',researchReviewFullTextDecisionHistorySchema,researchReviewFullTextDecisionInspectionSchema.array()),
  suggest:descriptor('research.reviewFullTextScreening.suggest',researchReviewFullTextSuggestionCreateSchema,researchReviewFullTextSuggestionInspectionSchema),
  suggestions:descriptor('research.reviewFullTextScreening.suggestions',researchReviewFullTextSuggestionListSchema,researchReviewFullTextSuggestionInspectionSchema.array()),
  phase:descriptor('research.reviewFullTextScreening.phase',researchReviewFullTextPhaseGetSchema,researchReviewFullTextFrozenPhaseSchema),
  freeze:descriptor('research.reviewFullTextScreening.freeze',researchReviewFullTextFreezeRequestSchema,researchReviewFullTextFrozenPhaseSchema),
  adjudicate:descriptor('research.reviewFullTextScreening.adjudicate',researchReviewFullTextArbitrationSaveSchema,researchReviewFullTextArbitrationInspectionSchema),
  arbitrations:descriptor('research.reviewFullTextScreening.arbitrations',researchReviewFullTextArbitrationHistorySchema,researchReviewFullTextArbitrationInspectionSchema.array())
};
export const researchReviewFullTextScreeningCapabilities=Object.values(capabilities);
export function registerResearchReviewFullTextScreeningCapabilities(context:RocPluginContext,repository:ResearchReviewFullTextScreening,
  arbitration:ResearchReviewFullTextArbitration,freezing:ResearchReviewFullTextFreeze):void {
  function register<TInput,TOutput>(capability:CapabilityDescriptor<TInput,TOutput>,run:(request:TInput)=>TOutput|Promise<TOutput>):void {
    context.capabilities.register(context.pluginId,capability,async input=>{
      try{return await run(capability.inputSchema.parse(input));}catch(error){throwSystematicReviewError(error);}
    });
  }
  register(capabilities.save,request=>repository.save(request,requireResearchHuman('research.reviewFullTextScreening.save',request.projectId)));
  register(capabilities.history,request=>repository.history(request));
  register(capabilities.suggestions,request=>repository.listSuggestions(request));
  register(capabilities.phase,request=>freezing.getPhase(request));
  register(capabilities.freeze,request=>freezing.freeze(request,requireResearchHuman('research.reviewFullTextScreening.freeze',request.projectId)));
  register(capabilities.adjudicate,request=>arbitration.save(request,requireResearchHuman('research.reviewFullTextScreening.adjudicate',request.projectId)));
  register(capabilities.arbitrations,request=>arbitration.history(request));
  context.capabilities.register(context.pluginId,capabilities.suggest,async(input,operation)=>{
    try {
      if(operation===undefined||operation.capabilityName!==capabilities.suggest.name||operation.capabilityVersion===undefined) {
        throw new Error('research_review_screening_tool_context_required');
      }
      return await repository.suggest(capabilities.suggest.inputSchema.parse(input),{
        kind:'agent_tool',operationId:operation.operationId,idempotencyKey:operation.idempotencyKey,
        toolCallId:operation.toolCallId,canonicalToolIdentity:operation.canonicalToolIdentity,toolVersion:operation.toolVersion,
        attemptId:operation.attemptId,capabilityName:'research.reviewFullTextScreening.suggest',capabilityVersion:operation.capabilityVersion
      });
    }catch(error){throwSystematicReviewError(error);}
  });
}
function descriptor<TInput,TOutput>(name:string,inputSchema:z.ZodType<TInput>,outputSchema:z.ZodType<TOutput>):CapabilityDescriptor<TInput,TOutput> {
  return {name,version:'1.0.0',inputSchema,outputSchema};
}
