import {AsyncLocalStorage} from 'node:async_hooks';
import type {ResearchRelationReviewer} from '../../shared/schemas/research-evidence-relations';
import {RocDomainError} from './errors';

export type ResearchRelationHumanCapability = 'research.relations.propose' | 'research.relations.review';
type HumanRelationContext = Readonly<{
  capability: ResearchRelationHumanCapability;
  projectId: string;
  reviewer: ResearchRelationReviewer;
}>;
const humanRelationContext = new AsyncLocalStorage<HumanRelationContext>();

/** Called by the main IPC adapter with the validated sender, never from renderer arguments. */
export function withResearchRelationHumanContext<T>(
  input: {capability: ResearchRelationHumanCapability; projectId: string; windowId: number},
  action: () => T
): T {
  if (!Number.isInteger(input.windowId) || input.windowId <= 0) {
    throw new RocDomainError({code: 'research_relation_sender_required',
      message: '关系审核缺少有效的窗口调用身份。', category: 'permission', retryable: false});
  }
  return humanRelationContext.run(Object.freeze({
    capability: input.capability, projectId: input.projectId,
    reviewer: Object.freeze({kind: 'user', id: `window:${input.windowId}`})
  }), action);
}

export function requireResearchRelationHuman(
  capability: ResearchRelationHumanCapability, projectId: string
): ResearchRelationReviewer {
  const context = humanRelationContext.getStore();
  if (context === undefined || context.capability !== capability) throw new Error('research_relation_human_required');
  if (context.projectId !== projectId) throw new Error('research_relation_project_mismatch');
  return context.reviewer;
}
