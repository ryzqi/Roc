import {z} from 'zod';
import {
  researchReviewScreeningPlanCreateSchema, researchReviewScreeningPlanGetSchema, researchReviewScreeningPlanInspectionSchema,
  researchReviewScreeningDecisionSaveSchema, researchReviewScreeningDecisionInspectionSchema, researchReviewScreeningDecisionHistorySchema,
  researchReviewScreeningSuggestionCreateSchema, researchReviewScreeningSuggestionInspectionSchema,
  researchReviewScreeningSuggestionListSchema, researchReviewScreeningPhaseGetSchema, researchReviewScreeningResolvedPhaseSchema,
  researchReviewScreeningArbitrationSaveSchema, researchReviewScreeningArbitrationInspectionSchema, researchReviewScreeningArbitrationHistorySchema
} from '../../../shared/schemas/research-review-screening';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import type {ResearchReviewScreeningRepository} from './review-screening-repository';
import type {ResearchReviewScreeningDecisions} from './review-screening-decisions';
import type {ResearchReviewScreeningArbitration} from './review-screening-arbitration';

const capabilities = {
  createPlan: descriptor('research.reviewScreening.createPlan', researchReviewScreeningPlanCreateSchema, researchReviewScreeningPlanInspectionSchema),
  getPlan: descriptor('research.reviewScreening.getPlan', researchReviewScreeningPlanGetSchema, researchReviewScreeningPlanInspectionSchema),
  save: descriptor('research.reviewScreening.save', researchReviewScreeningDecisionSaveSchema, researchReviewScreeningDecisionInspectionSchema),
  history: descriptor('research.reviewScreening.history', researchReviewScreeningDecisionHistorySchema, researchReviewScreeningDecisionInspectionSchema.array()),
  suggest: descriptor('research.reviewScreening.suggest', researchReviewScreeningSuggestionCreateSchema, researchReviewScreeningSuggestionInspectionSchema),
  suggestions: descriptor('research.reviewScreening.suggestions', researchReviewScreeningSuggestionListSchema, researchReviewScreeningSuggestionInspectionSchema.array()),
  phase: descriptor('research.reviewScreening.phase', researchReviewScreeningPhaseGetSchema, researchReviewScreeningResolvedPhaseSchema),
  adjudicate: descriptor('research.reviewScreening.adjudicate', researchReviewScreeningArbitrationSaveSchema, researchReviewScreeningArbitrationInspectionSchema),
  arbitrations: descriptor('research.reviewScreening.arbitrations', researchReviewScreeningArbitrationHistorySchema, researchReviewScreeningArbitrationInspectionSchema.array())
};
export const researchReviewScreeningCapabilities = Object.values(capabilities);
export function registerResearchReviewScreeningCapabilities(context: RocPluginContext, repository: ResearchReviewScreeningRepository,
  decisions: ResearchReviewScreeningDecisions, arbitration: ResearchReviewScreeningArbitration): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return run(capability.inputSchema.parse(input));}
      catch (error) {throwSystematicReviewError(error);}
    });
  }
  register(capabilities.createPlan, request => repository.createPlan(request, requireResearchHuman('research.reviewScreening.createPlan', request.projectId)));
  register(capabilities.getPlan, request => repository.getPlan(request));
  register(capabilities.save, request => decisions.save(request, requireResearchHuman('research.reviewScreening.save', request.projectId)));
  register(capabilities.history, request => decisions.history(request));
  register(capabilities.suggestions, request => decisions.listSuggestions(request));
  register(capabilities.phase, request => arbitration.getPhase(request));
  register(capabilities.adjudicate, request => arbitration.save(request, requireResearchHuman('research.reviewScreening.adjudicate', request.projectId)));
  register(capabilities.arbitrations, request => arbitration.history(request));
  context.capabilities.register(context.pluginId, capabilities.suggest, async (input, operation) => {
    try {
      if (operation === undefined || operation.capabilityName !== capabilities.suggest.name || operation.capabilityVersion === undefined) {
        throw new Error('research_review_screening_tool_context_required');
      }
      return decisions.suggest(capabilities.suggest.inputSchema.parse(input), {
        kind: 'agent_tool', operationId: operation.operationId, idempotencyKey: operation.idempotencyKey,
        toolCallId: operation.toolCallId, canonicalToolIdentity: operation.canonicalToolIdentity,
        toolVersion: operation.toolVersion, attemptId: operation.attemptId,
        capabilityName: 'research.reviewScreening.suggest', capabilityVersion: operation.capabilityVersion
      });
    } catch (error) {throwSystematicReviewError(error);}
  });
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
