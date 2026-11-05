import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import type {ResearchReviewSearchStart} from '../../shared/schemas/research-review-search';

type ReviewDispatchContext = {reference: string; signal: AbortSignal};
const contexts = new AsyncLocalStorage<ReviewDispatchContext>();

export function withReviewSearchDispatch<T>(context: ReviewDispatchContext, operation: () => T): T {
  context.signal.throwIfAborted();
  return contexts.run(context, operation);
}

export function reviewSearchDispatchContext(): ReviewDispatchContext | undefined {
  return contexts.getStore();
}

export function reviewSearchDispatchRequestHash(request: ResearchReviewSearchStart): string {
  return createHash('sha256').update(JSON.stringify({
    domain: 'research_review_execute_query',
    projectId: request.projectId, requestId: request.requestId, versionId: request.versionId,
    expectedFreezeHash: request.expectedFreezeHash, databaseIndex: request.databaseIndex,
    queryIndex: request.queryIndex, retryOf: request.retryOf,
    expectedRetrySnapshotHash: request.expectedRetrySnapshotHash
  })).digest('hex');
}
