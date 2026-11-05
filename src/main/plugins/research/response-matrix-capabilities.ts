import type {z} from 'zod';
import {
  researchResponseMatrixSaveSchema, researchResponseMatrixReceiptSchema, researchResponseMatrixInspectSchema,
  researchResponseMatrixInspectionSchema, researchResponseMatrixHistorySchema, researchResponseMatrixHistoryResultSchema
} from '../../../shared/schemas/research-response-matrix';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {RocErrorCategory} from '../../../shared/types';
import type {ResearchResponseMatrixRepository} from './response-matrix-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  save: descriptor('research.responseMatrix.save', researchResponseMatrixSaveSchema, researchResponseMatrixReceiptSchema),
  inspect: descriptor('research.responseMatrix.inspect', researchResponseMatrixInspectSchema, researchResponseMatrixInspectionSchema),
  history: descriptor('research.responseMatrix.history', researchResponseMatrixHistorySchema, researchResponseMatrixHistoryResultSchema)
};
export const researchResponseMatrixCapabilities = Object.values(capabilities);
export function registerResearchResponseMatrixCapabilities(context: RocPluginContext, repository: ResearchResponseMatrixRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (input: I) => O): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return action(capability.inputSchema.parse(input));}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.name === 'ZodError' || error instanceof SyntaxError ?
          'research_response_contract_invalid' : error.message.split(':')[0];
        const detail = errors[code];
        if (detail === undefined) throw error;
        throw new RocDomainError({code, ...detail, retryable: false});
      }
    });
  }
  register(capabilities.save, input => repository.save(input));
  register(capabilities.inspect, input => repository.inspect(input));
  register(capabilities.history, input => repository.history(input));
}
const errors: Record<string, {message: string; category: RocErrorCategory}> = {
  research_response_contract_invalid: {message: '审稿意见、回复或位置不符合合同。', category: 'validation'},
  research_response_location_invalid: {message: '修改位置与当前正文的精确字符范围不一致。', category: 'validation'},
  research_response_project_mismatch: {message: '审稿矩阵不属于当前项目。', category: 'permission'},
  research_human_required: {message: '保存审稿矩阵需要当前窗口的人工操作。', category: 'permission'},
  research_human_project_mismatch: {message: '人工操作身份不属于当前项目。', category: 'permission'},
  research_project_archived: {message: '归档项目不能保存审稿矩阵。', category: 'permission'},
  research_artifact_immutable: {message: '已批准工件不能修改审稿矩阵。', category: 'permission'},
  research_artifact_stage_inactive: {message: '工件不属于当前阶段。', category: 'permission'},
  research_relation_artifact_inactive: {message: '工件不属于当前有效工件集合。', category: 'permission'},
  research_relation_stage_not_reviewable: {message: '当前阶段不能保存审稿矩阵。', category: 'permission'},
  research_response_request_conflict: {message: '重试身份或审稿内容与原请求不同。', category: 'conflict'},
  research_response_version_conflict: {message: '审稿矩阵已有新版本，请重新读取。', category: 'conflict'},
  research_response_artifact_changed: {message: '修改稿版本已变化，请重新核对。', category: 'conflict'},
  research_response_comment_removed: {message: '已有意见需要保留，并明确记录人工处理结果。', category: 'validation'},
  research_response_comment_changed: {message: '原始意见与审稿人不能被覆盖。', category: 'validation'},
  research_response_source_changed: {message: '修改稿或关联证据已变化，请重新核对。', category: 'conflict'},
  research_manuscript_stale: {message: '正文主张或来源已变化，请先重新保存正文。', category: 'conflict'},
  research_manuscript_artifact_required: {message: '审稿矩阵需要论文工件。', category: 'validation'},
  research_manuscript_required: {message: '请先保存论文正文。', category: 'validation'},
  research_evidence_project_mismatch: {message: '关联证据不属于当前项目。', category: 'permission'},
  research_response_snapshot_invalid: {message: '审稿矩阵保存回执校验失败。', category: 'degraded'},
  research_evidence_integrity_invalid: {message: '关联证据校验失败。', category: 'degraded'},
  research_evidence_reference_superseded: {message: '关联证据来源已更新，请重新核对修改稿。', category: 'conflict'},
  research_project_not_found: {message: '项目不存在。', category: 'not_found'},
  research_artifact_not_found: {message: '工件不存在。', category: 'not_found'},
  research_evidence_not_found: {message: '关联证据不存在。', category: 'not_found'}
};
