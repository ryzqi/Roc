import type {z} from 'zod';
import {
  researchCitationReviewSaveSchema, researchCitationReviewReceiptSchema,
  researchCitationReviewHistorySchema, researchCitationReviewHistoryResultSchema
} from '../../../shared/schemas/research-citation-reviews';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {RocErrorCategory} from '../../../shared/types';
import type {ResearchCitationReviewRepository} from './citation-review-repository';

const capabilities = {
  save: descriptor('research.citationReviews.save', researchCitationReviewSaveSchema, researchCitationReviewReceiptSchema),
  history: descriptor('research.citationReviews.history', researchCitationReviewHistorySchema, researchCitationReviewHistoryResultSchema)
};
export const researchCitationReviewCapabilities = Object.values(capabilities);

export function registerResearchCitationReviewCapabilities(context: RocPluginContext, repository: ResearchCitationReviewRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (input: I) => O): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return action(capability.inputSchema.parse(input));}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.name === 'ZodError' || error instanceof SyntaxError ?
          'research_citation_review_contract_invalid' : error.message.split(':')[0];
        const detail = errors[code];
        if (detail === undefined) throw error;
        throw new RocDomainError({code, ...detail, retryable: false});
      }
    });
  }
  register(capabilities.save, input => repository.save(input));
  register(capabilities.history, input => repository.history(input));
}
const errors: Record<string, {message: string; category: RocErrorCategory}> = {
  research_citation_review_contract_invalid: {message: '引用审核请求或保存的回执不符合合同。', category: 'validation'},
  research_citation_review_citation_required: {message: '请选择当前正文主张实际引用的证据。', category: 'validation'},
  research_manuscript_artifact_required: {message: '请选择正文工件。', category: 'validation'},
  research_manuscript_required: {message: '先保存正文，再审核引用。', category: 'validation'},
  research_human_required: {message: '引用审核需要当前窗口的人工操作。', category: 'permission'},
  research_human_project_mismatch: {message: '窗口审核身份不属于当前项目。', category: 'permission'},
  research_citation_review_project_mismatch: {message: '主张或工件不属于当前项目。', category: 'permission'},
  research_evidence_project_mismatch: {message: '证据不属于当前项目。', category: 'permission'},
  research_project_archived: {message: '归档项目不能新增引用审核。', category: 'permission'},
  research_artifact_immutable: {message: '已批准工件不能修改引用审核。', category: 'permission'},
  research_artifact_stage_inactive: {message: '正文不属于当前阶段。', category: 'permission'},
  research_relation_artifact_inactive: {message: '正文不属于当前有效工件。', category: 'permission'},
  research_relation_stage_not_reviewable: {message: '当前阶段不能进行引用审核。', category: 'permission'},
  research_citation_review_request_conflict: {message: '重试身份或审核内容与已保存请求不同。', category: 'conflict'},
  research_citation_review_version_conflict: {message: '引用审核已有新版本，请重新读取。', category: 'conflict'},
  research_citation_review_report_changed: {message: '正文引用报告已变化，请重新核对后审核。', category: 'conflict'},
  research_citation_review_source_changed: {message: '审核绑定的主张或来源已变化。', category: 'conflict'},
  research_manuscript_stale: {message: '正文主张或来源已变化，请重新保存正文。', category: 'conflict'},
  research_evidence_reference_superseded: {message: '引用来源已失效，请捕获新版本。', category: 'conflict'},
  research_citation_review_snapshot_invalid: {message: '保存的引用审核回执校验失败。', category: 'degraded'},
  research_evidence_integrity_invalid: {message: '证据原文与内容校验值不一致。', category: 'degraded'},
  research_project_not_found: {message: '项目不存在。', category: 'not_found'},
  research_artifact_not_found: {message: '正文工件不存在。', category: 'not_found'},
  research_claim_not_found: {message: '正文主张不存在。', category: 'not_found'},
  research_evidence_not_found: {message: '引用证据不存在。', category: 'not_found'}
};
function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
