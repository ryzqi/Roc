import {AsyncLocalStorage} from 'node:async_hooks';
import type {ResearchNodeLease} from '../../../../shared/schemas/research-task-graph';

const worker = new AsyncLocalStorage<ResearchNodeLease>();
export function withResearchWorker<T>(lease: ResearchNodeLease, work: () => T): T {
  return worker.run(Object.freeze({...lease}), work);
}
export function researchWorkerLease(): ResearchNodeLease {
  const lease = worker.getStore();
  if (lease === undefined) throw new Error('research_node_worker_required');
  return lease;
}
