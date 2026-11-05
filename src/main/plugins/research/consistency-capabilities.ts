import type {z} from 'zod';
import {
  researchConsistencySaveSchema, researchConsistencyReceiptSchema, researchConsistencyHistorySchema,
  researchConsistencyHistoryResultSchema, researchConsistencyInspectSchema, researchConsistencyInspectionSchema
} from '../../../shared/schemas/research-consistency';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {RocErrorCategory} from '../../../shared/types';
import type {ResearchConsistencyService} from './consistency-service';
import type {ResearchConsistencyRepository} from './consistency-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  save: descriptor('research.consistency.save', researchConsistencySaveSchema, researchConsistencyReceiptSchema),
  history: descriptor('research.consistency.history', researchConsistencyHistorySchema, researchConsistencyHistoryResultSchema),
  inspect: descriptor('research.consistency.inspect', researchConsistencyInspectSchema, researchConsistencyInspectionSchema)
};
export const researchConsistencyCapabilities = Object.values(capabilities);
export function registerResearchConsistencyCapabilities(context: RocPluginContext,
  service: ResearchConsistencyService, repository: ResearchConsistencyRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await action(capability.inputSchema.parse(input));}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.name === 'ZodError' || error instanceof SyntaxError ?
          'research_consistency_contract_invalid' : error.message.split(':')[0];
        const detail = errors[code];
        if (detail === undefined) throw error;
        throw new RocDomainError({code, ...detail, retryable: false});
      }
    });
  }
  register(capabilities.save, input => service.save(input));
  register(capabilities.history, input => repository.history(input));
  register(capabilities.inspect, input => service.inspect(input));
}
const errors: Record<string, {message: string; category: RocErrorCategory}> = {
  research_consistency_contract_invalid: {message: '数值映射或保存回执不符合合同。', category: 'validation'},
  research_consistency_span_invalid: {message: '请选择主张中完整的数值字符范围。', category: 'validation'},
  research_consistency_unit_mismatch: {message: '指标与展示单位不同，请明确填写转换规则。', category: 'validation'},
  research_consistency_metric_invalid: {message: '请选择真实结果指标及其证据版本。', category: 'validation'},
  research_consistency_evidence_required: {message: '主张必须引用该指标证据。', category: 'validation'},
  research_consistency_claim_required: {message: '数值主张不在当前保存的正文中。', category: 'validation'},
  research_consistency_calculation_range: {message: '转换或容差计算超出有限数值范围。', category: 'validation'},
  research_consistency_project_mismatch: {message: '数值主张或工件不属于当前项目。', category: 'permission'},
  research_result_project_mismatch: {message: '指标结果不属于当前项目。', category: 'permission'},
  research_evidence_project_mismatch: {message: '指标证据不属于当前项目。', category: 'permission'},
  research_human_required: {message: '保存数值映射需要当前窗口的人工操作。', category: 'permission'},
  research_human_project_mismatch: {message: '人工操作身份不属于当前项目。', category: 'permission'},
  research_project_archived: {message: '归档项目不能保存数值映射。', category: 'permission'},
  research_artifact_immutable: {message: '已批准工件不能修改数值映射。', category: 'permission'},
  research_artifact_stage_inactive: {message: '工件不属于当前阶段。', category: 'permission'},
  research_relation_artifact_inactive: {message: '工件不属于当前有效工件。', category: 'permission'},
  research_relation_stage_not_reviewable: {message: '当前阶段不能保存数值映射。', category: 'permission'},
  research_consistency_request_conflict: {message: '重试身份或映射内容与已保存请求不同。', category: 'conflict'},
  research_consistency_version_conflict: {message: '数值映射已有新版本，请重新读取。', category: 'conflict'},
  research_consistency_artifact_changed: {message: '工件版本已变化，请重新核对。', category: 'conflict'},
  research_consistency_claim_changed: {message: '数值位置绑定的主张已变化。', category: 'conflict'},
  research_consistency_source_changed: {message: '数值映射绑定的指标来源已变化。', category: 'conflict'},
  research_manuscript_stale: {message: '正文主张或来源已变化，请重新保存正文。', category: 'conflict'},
  research_evidence_reference_superseded: {message: '指标来源已失效，请捕获当前版本。', category: 'conflict'},
  research_result_execution_changed: {message: '指标运行快照已变化。', category: 'conflict'},
  research_experiment_snapshot_changed: {message: '实验快照或文件已变化。', category: 'conflict'},
  research_result_source_changed: {message: '实验源代码已变化。', category: 'conflict'},
  research_result_output_changed: {message: '结果文件已变化。', category: 'conflict'},
  research_result_evidence_changed: {message: '指标证据与结果回执不一致。', category: 'conflict'},
  research_consistency_snapshot_invalid: {message: '数值映射回执校验失败。', category: 'degraded'},
  research_result_snapshot_invalid: {message: '指标结果回执校验失败。', category: 'degraded'},
  research_evidence_integrity_invalid: {message: '指标证据校验失败。', category: 'degraded'},
  research_project_not_found: {message: '项目不存在。', category: 'not_found'},
  research_artifact_not_found: {message: '工件不存在。', category: 'not_found'},
  research_claim_not_found: {message: '数值主张不存在。', category: 'not_found'},
  research_evidence_not_found: {message: '指标证据不存在。', category: 'not_found'},
  research_result_not_found: {message: '指标结果不存在。', category: 'not_found'}
};
