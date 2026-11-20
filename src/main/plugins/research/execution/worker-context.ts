import {AsyncLocalStorage} from 'node:async_hooks';
import {AsyncLocalStorageProviderSingleton} from '@langchain/core/singletons';
import type {ResearchNodeLease} from '../../../../shared/schemas/research-task-graph';
import {runWithoutCapabilityOperationContext} from '../../../kernel/capability-operation-context';

const worker = new AsyncLocalStorage<ResearchNodeLease>();
export function withResearchWorker<T>(lease: ResearchNodeLease, work: () => T): T {
  // A detached role owns its graph, cancellation and tool effects independently of the launching chat.
  return runWithoutCapabilityOperationContext(() =>
    AsyncLocalStorageProviderSingleton.runWithConfig({}, () => worker.run(Object.freeze({...lease}), work), true));
}
export function researchWorkerLease(): ResearchNodeLease {
  const lease = worker.getStore();
  if (lease === undefined) throw new Error('research_node_worker_required');
  return lease;
}
