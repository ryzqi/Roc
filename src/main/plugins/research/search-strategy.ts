import { createHash } from 'node:crypto';
import type { ResearchArtifact, ResearchStageOutput } from '../../../shared/types';
import type { ResearchSearchPlan } from '../../../shared/schemas/research-search-plan';
import type { LiteratureExecutionContext } from '../../services/literature-context';
import type { ResearchRepository } from './repository';
import type { ResearchExecutionContext } from './run-repository';

export function searchPlanReviewMarkdown(plan: ResearchSearchPlan): string {
  return `\n\n## 待确认检索计划\n\n以下原始研究指令和模型拆解仍是建议；批准此工件后，仅执行 queries 中的固定查询、来源、年份范围和分页上限。\nexcludedTerms 是筛选标准，API 查询是否排除这些词由各查询式明确表达。\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
}

export function requireSearchPlanContent(repository: ResearchRepository, artifact: ResearchArtifact): ResearchStageOutput & {searchPlan: ResearchSearchPlan} {
  const content = repository.runs.getArtifactContent(artifact.projectId, artifact.id);
  if (content?.output.searchPlan === undefined) throw new Error('research_search_plan_required');
  const origin = repository.runs.get(content.runId, artifact.projectId);
  if (origin.stage !== 'discovery' || content.output.searchPlan.researchQuestion !== origin.instruction) {
    throw new Error('research_search_question_changed');
  }
  if (!content.output.markdown.endsWith(searchPlanReviewMarkdown(content.output.searchPlan))) {
    throw new Error('research_search_plan_review_missing');
  }
  return {...content.output, searchPlan: content.output.searchPlan};
}

const hash = (output: ResearchStageOutput): string => createHash('sha256').update(JSON.stringify(output)).digest('hex');
export function searchPlanApprovalHash(projectId: string, artifactId: string, output: ResearchStageOutput): string {
  return createHash('sha256').update(JSON.stringify({projectId, artifactId, output})).digest('hex');
}

/** Only the real human gate can make a discovery artifact eligible for retrieval. */
export function requireConfirmedSearchStrategy(repository: ResearchRepository, context: ResearchExecutionContext): NonNullable<LiteratureExecutionContext['searchStrategy']> {
  const candidates = context.inputs.filter(entry => entry.artifact.kind === 'search_strategy');
  if (candidates.length !== 1) throw new Error('research_confirmed_search_plan_required');
  const frozen = candidates[0];
  if (frozen.output?.searchPlan === undefined) throw new Error('research_search_plan_required');
  const contentHash = hash(frozen.output);
  const assertCurrent = () => {
    if (hash(frozen.output!) !== contentHash) throw new Error('research_search_plan_changed');
    const discovery = repository.getWorkflow(context.project.id).stages.find(stage => stage.stage === 'discovery');
    if (discovery?.gateApproved !== true) throw new Error('research_confirmed_search_plan_required');
    const artifact = repository.getArtifact(frozen.artifact.id);
    if (artifact.projectId !== context.project.id || artifact.status !== 'approved' || artifact.updatedAt !== frozen.artifact.updatedAt) {
      throw new Error('research_search_plan_changed');
    }
    if (hash(requireSearchPlanContent(repository, artifact)) !== contentHash) throw new Error('research_search_plan_changed');
  };
  assertCurrent();
  return {plan: frozen.output.searchPlan, artifactId: frozen.artifact.id, contentHash, approvedAt: frozen.artifact.updatedAt, assertCurrent};
}
