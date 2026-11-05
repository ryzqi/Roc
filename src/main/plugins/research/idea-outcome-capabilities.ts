import type {z} from 'zod';
import {
  researchIdeaOutcomeSaveSchema, researchIdeaOutcomeGetSchema, researchIdeaOutcomeHistorySchema,
  researchIdeaOutcomeReceiptSchema, researchIdeaOutcomeHistoryResultSchema
} from '../../../shared/schemas/research-idea-outcomes';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {ResearchIdeaOutcomeRepository} from './idea-outcome-repository';
import type {ResearchIdeaOutcomeService} from './idea-outcome-service';
import type {RocErrorCategory} from '../../../shared/types';

const capabilities = {
  save: descriptor('research.ideaOutcomes.save', researchIdeaOutcomeSaveSchema, researchIdeaOutcomeReceiptSchema),
  get: descriptor('research.ideaOutcomes.get', researchIdeaOutcomeGetSchema, researchIdeaOutcomeReceiptSchema),
  history: descriptor('research.ideaOutcomes.history', researchIdeaOutcomeHistorySchema, researchIdeaOutcomeHistoryResultSchema)
};
export const researchIdeaOutcomeCapabilities = Object.values(capabilities);

export function registerResearchIdeaOutcomeCapabilities(context: RocPluginContext,
  repository: ResearchIdeaOutcomeRepository, service: ResearchIdeaOutcomeService): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (request: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await action(capability.inputSchema.parse(input));}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.name === 'ZodError' || error instanceof SyntaxError ? 'research_idea_outcome_contract_invalid' : error.message.split(':')[0];
        const detail = errors[code];
        if (detail === undefined) throw error;
        throw new RocDomainError({code, ...detail, retryable: false});
      }
    });
  }
  register(capabilities.save, request => service.save(request));
  register(capabilities.get, request => service.get(request));
  register(capabilities.history, request => repository.history(request));
}

const errors: Record<string, {message: string; category: RocErrorCategory}> = {
  research_idea_outcome_contract_invalid: {category: 'validation', message: '结果评估请求或回执不符合合同。'},
  research_idea_outcome_metric_mapping_invalid: {category: 'validation', message: '每个计划指标须明确关联结果证据或说明缺失。'},
  research_idea_outcome_frozen_plan_required: {category: 'conflict', message: '结果评估需要精确的已冻结方法计划。'},
  research_idea_outcome_result_evidence_required: {category: 'validation', message: '指标证据必须来自选中结果回执的真实指标。'},
  research_idea_outcome_comparability_conflict: {category: 'conflict', message: '指标缺失或定义、单位、方向不同，只能记录不可比评估。'},
  research_idea_outcome_material_changed: {category: 'conflict', message: '计划、结果或证据已变化，请重新核对。'},
  research_idea_outcome_request_conflict: {category: 'conflict', message: '同一评估请求的内容或人工身份已变化。'},
  research_idea_outcome_version_conflict: {category: 'conflict', message: '结果评估版本已变化，请读取最新版本。'},
  research_idea_outcome_snapshot_invalid: {category: 'degraded', message: '保存的结果评估回执校验失败。'},
  research_idea_outcome_not_found: {category: 'not_found', message: '结果评估版本不存在。'},
  research_idea_outcome_project_mismatch: {category: 'permission', message: '结果评估与当前项目不一致。'},
  research_project_not_found: {category: 'not_found', message: '科研项目不存在。'},
  research_artifact_not_found: {category: 'not_found', message: 'Idea Canvas 工件不存在。'},
  research_idea_canvas_artifact_required: {category: 'validation', message: '结果评估需要 Idea Canvas 工件。'},
  research_project_archived: {category: 'permission', message: '项目已归档，结果评估仅可阅读。'},
  research_human_required: {category: 'permission', message: '结果评估需要有效的人工窗口身份。'},
  research_human_project_mismatch: {category: 'permission', message: '人工窗口身份与当前项目不一致。'},
  research_evidence_reference_superseded: {category: 'conflict', message: '结果指标证据已失效，需要重新核查。'},
  research_evidence_not_found: {category: 'not_found', message: '结果指标证据不存在。'},
  research_evidence_project_mismatch: {category: 'permission', message: '结果指标证据不属于当前项目。'},
  research_evidence_integrity_invalid: {category: 'degraded', message: '结果指标证据校验失败。'},
  research_idea_plan_version_conflict: {category: 'conflict', message: '方法计划版本不匹配。'},
  research_idea_plan_not_found: {category: 'not_found', message: '方法计划版本不存在。'},
  research_idea_plan_project_mismatch: {category: 'permission', message: '方法计划不属于当前项目或工件。'},
  research_idea_plan_snapshot_invalid: {category: 'degraded', message: '方法计划冻结回执校验失败。'},
  research_result_hash_mismatch: {category: 'conflict', message: '结果回执版本不匹配。'},
  research_result_not_found: {category: 'not_found', message: '结果回执不存在。'},
  research_result_project_mismatch: {category: 'permission', message: '结果回执不属于当前项目。'},
  research_result_evidence_changed: {category: 'degraded', message: '指标证据与选中的结果回执不一致。'},
  research_result_execution_changed: {category: 'conflict', message: '结果所属运行已变化。'},
  research_result_output_changed: {category: 'conflict', message: '实际结果文件已变化。'},
  research_result_source_changed: {category: 'conflict', message: '实际实验代码已变化。'},
  research_result_snapshot_invalid: {category: 'degraded', message: '结果回执校验失败。'},
  research_experiment_manifest_file_changed: {category: 'conflict', message: '实际实验文件已变化，无法复核结果评估。'}
};
function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
