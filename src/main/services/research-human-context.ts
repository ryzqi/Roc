import {AsyncLocalStorage} from 'node:async_hooks';
import type {ResearchRelationReviewer} from '../../shared/schemas/research-evidence-relations';
import {RocDomainError} from './errors';

export type ResearchHumanCapability = 'research.relations.propose' | 'research.relations.review' |
  'research.sourceMigrations.capture' | 'research.sourceMigrations.reject' | 'research.sourceReplacements.replace' |
  'research.annotations.create' | 'research.annotations.capture' |
  'research.reviewProtocol.save' | 'research.reviewProtocol.freeze' |
  'research.reviewSearch.start' | 'research.reviewSearch.cancel' | 'research.reviewCorpus.create' |
  'research.reviewDeduplication.save' | 'research.reviewDeduplication.freeze' |
  'research.reviewScreening.createPlan' | 'research.reviewScreening.save' | 'research.reviewScreening.adjudicate' | 'research.reviewScreening.freeze' |
  'research.reviewFullText.save' | 'research.reviewFullTextScreening.save' | 'research.reviewFullTextScreening.adjudicate' | 'research.reviewFullTextScreening.freeze' |
  'research.reviewExtraction.save';
type HumanContext = Readonly<{
  capability: ResearchHumanCapability;
  projectId: string;
  actor: ResearchRelationReviewer;
}>;
const humanContext = new AsyncLocalStorage<HumanContext>();

/** Main IPC binds the validated sender. Wire arguments cannot supply human authority. */
export function withResearchHumanContext<T>(
  input: {capability: ResearchHumanCapability; projectId: string; windowId: number},
  action: () => T
): T {
  if (!Number.isInteger(input.windowId) || input.windowId <= 0) {
    throw new RocDomainError({code: 'research_sender_required',
      message: '研究审核缺少有效的窗口调用身份。', category: 'permission', retryable: false});
  }
  return humanContext.run(Object.freeze({
    capability: input.capability, projectId: input.projectId,
    actor: Object.freeze({kind: 'user', id: `window:${input.windowId}`})
  }), action);
}

export function requireResearchHuman(capability: ResearchHumanCapability, projectId: string): ResearchRelationReviewer {
  const context = humanContext.getStore();
  if (context === undefined || context.capability !== capability) throw new Error('research_human_required');
  if (context.projectId !== projectId) throw new Error('research_human_project_mismatch');
  return context.actor;
}
