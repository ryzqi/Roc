import {z} from 'zod';
import {
  researchReviewSearchStartSchema, researchReviewSearchGetSchema, researchReviewSearchListSchema,
  researchReviewSearchInspectionSchema, researchReviewSearchPoolRequestSchema, researchReviewSearchPoolResultSchema,
  researchReviewSearchCancelSchema, researchReviewOwnedSearchInspectionSchema
} from '../../../shared/schemas/research-review-search';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchReviewSearchService} from './review-search-service';
import {throwSystematicReviewError} from './systematic-review-capabilities';
import {assertReviewSearchOwner, type ExecutionGrantBroker} from '../../services/deep-agent/execution-grant-broker';
import {reviewSearchDispatchContext} from '../../services/research-review-dispatch-context';
import {reviewSearchOwnerContext} from '../../services/research-review-owner-context';

const capabilities = {
  start: descriptor('research.reviewSearch.start', researchReviewSearchStartSchema, researchReviewSearchInspectionSchema),
  get: descriptor('research.reviewSearch.get', researchReviewSearchGetSchema, researchReviewSearchInspectionSchema),
  list: descriptor('research.reviewSearch.list', researchReviewSearchListSchema, researchReviewSearchInspectionSchema.array()),
  pool: descriptor('research.reviewSearch.pool', researchReviewSearchPoolRequestSchema, researchReviewSearchPoolResultSchema),
  cancel: descriptor('research.reviewSearch.cancel', researchReviewSearchCancelSchema, researchReviewSearchInspectionSchema)
};
export const researchReviewSearchCapabilities = Object.values(capabilities);
const ownedCapabilities = {
  start: descriptor('research.reviewSearch.startOwned', researchReviewSearchStartSchema, researchReviewOwnedSearchInspectionSchema),
  get: descriptor('research.reviewSearch.getOwned', researchReviewSearchGetSchema, researchReviewOwnedSearchInspectionSchema),
  cancel: descriptor('research.reviewSearch.cancelOwned', researchReviewSearchCancelSchema, researchReviewOwnedSearchInspectionSchema)
};
export const researchOwnedReviewSearchCapabilities = Object.values(ownedCapabilities);

export function registerResearchOwnedReviewSearchCapabilities(
  context: RocPluginContext, service: ResearchReviewSearchService, broker: ExecutionGrantBroker
): void {
  context.capabilities.register(context.pluginId, ownedCapabilities.start, async input => {
    const request = researchReviewSearchStartSchema.parse(input), dispatch = reviewSearchDispatchContext();
    if (dispatch === undefined) throw new Error('research_review_dispatch_context_required');
    dispatch.signal.throwIfAborted();
    return service.startOwned(request, broker.consumeReviewSearchDispatch(dispatch.reference, request), dispatch.signal);
  });
  context.capabilities.register(context.pluginId, ownedCapabilities.get, async input => {
    const owner = reviewSearchOwnerContext();
    if (owner === undefined) throw new Error('research_review_owner_context_required');
    assertReviewSearchOwner(owner, 'research_review_get_query');
    return service.getOwned(researchReviewSearchGetSchema.parse(input), owner);
  });
  context.capabilities.register(context.pluginId, ownedCapabilities.cancel, async input => {
    const owner = reviewSearchOwnerContext();
    if (owner === undefined) throw new Error('research_review_owner_context_required');
    return service.cancelOwned(researchReviewSearchCancelSchema.parse(input), owner);
  });
}
export function registerResearchReviewSearchCapabilities(context: RocPluginContext, service: ResearchReviewSearchService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return run(capability.inputSchema.parse(input));}
      catch (error) {throwSystematicReviewError(error);}
    });
  }
  register(capabilities.start, request => service.start(request, requireResearchHuman('research.reviewSearch.start', request.projectId)));
  register(capabilities.cancel, request => service.cancel(request, requireResearchHuman('research.reviewSearch.cancel', request.projectId)));
  register(capabilities.get, request => service.get(request));
  register(capabilities.list, request => service.list(request));
  register(capabilities.pool, request => service.readPool(request));
}
function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
