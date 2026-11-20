import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ResearchStageRunStartRequest } from '../../shared/types';

const references = new AsyncLocalStorage<string>();

export function withResearchDispatchReference<T>(reference: string, operation: () => T): T {
  return references.run(reference, operation);
}

export function researchDispatchReference(): string | undefined {
  return references.getStore();
}

export function researchDispatchRequestHash(request: ResearchStageRunStartRequest): string {
  return createHash('sha256').update(JSON.stringify({
    projectId: request.projectId, expectedStage: request.expectedStage,
    instruction: request.instruction, requestId: request.requestId
  })).digest('hex');
}
