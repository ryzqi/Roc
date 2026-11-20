import {AsyncLocalStorage} from 'node:async_hooks';
import {assertReviewSearchOwner, type ConsumedReviewSearchOwner} from './deep-agent/execution-grant-broker';

const owners = new AsyncLocalStorage<ConsumedReviewSearchOwner>();

export function withReviewSearchOwner<T>(owner: ConsumedReviewSearchOwner, operation: () => T): T {
  assertReviewSearchOwner(owner);
  return owners.run(owner, operation);
}

export function reviewSearchOwnerContext(): ConsumedReviewSearchOwner | undefined {
  return owners.getStore();
}
