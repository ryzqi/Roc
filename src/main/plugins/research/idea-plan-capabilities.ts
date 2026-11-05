import type {z} from 'zod';
import {
  researchIdeaPlanSaveSchema, researchIdeaPlanGetSchema, researchIdeaPlanHistorySchema,
  researchIdeaPlanFreezeRequestSchema, researchIdeaPlanInspectionSchema, researchIdeaPlanHistoryResultSchema
} from '../../../shared/schemas/research-idea-plans';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {ResearchIdeaPlanRepository} from './idea-plan-repository';
import type {RocErrorCategory} from '../../../shared/types';

const capabilities = {
  save: descriptor('research.ideaPlans.save', researchIdeaPlanSaveSchema, researchIdeaPlanInspectionSchema),
  freeze: descriptor('research.ideaPlans.freeze', researchIdeaPlanFreezeRequestSchema, researchIdeaPlanInspectionSchema),
  get: descriptor('research.ideaPlans.get', researchIdeaPlanGetSchema, researchIdeaPlanInspectionSchema),
  history: descriptor('research.ideaPlans.history', researchIdeaPlanHistorySchema, researchIdeaPlanHistoryResultSchema)
};
export const researchIdeaPlanCapabilities = Object.values(capabilities);

export function registerResearchIdeaPlanCapabilities(context: RocPluginContext, repository: ResearchIdeaPlanRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (request: I) => O): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return action(capability.inputSchema.parse(input));}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.name === 'ZodError' || error instanceof SyntaxError ? 'research_idea_plan_contract_invalid' : error.message.split(':')[0];
        const detail = errors[code];
        if (detail === undefined) throw error;
        throw new RocDomainError({code, ...detail, retryable: false});
      }
    });
  }
  register(capabilities.save, request => repository.save(request));
  register(capabilities.freeze, request => repository.freeze(request));
  register(capabilities.get, request => repository.get(request));
  register(capabilities.history, request => repository.history(request));
}

const errors: Record<string, {message: string; category: RocErrorCategory}> = {
  research_idea_plan_contract_invalid: {category: 'validation', message: '方法计划请求或保存版本不符合合同。'},
  research_idea_plan_hypothesis_mismatch: {category: 'validation', message: '计划假设必须与选中的 Idea Canvas 完全一致。'},
  research_idea_plan_observation_conflict: {category: 'conflict', message: '已记录观察数据的计划不能改为观察数据前计划。'},
  research_idea_plan_version_conflict: {category: 'conflict', message: '计划版本已变化，请读取当前版本后操作。'},
  research_idea_plan_request_conflict: {category: 'conflict', message: '同一请求的内容或人工身份已变化。'},
  research_idea_plan_canvas_changed: {category: 'conflict', message: 'Idea Canvas 已变化，请基于当前版本修订计划。'},
  research_idea_plan_already_frozen: {category: 'conflict', message: '此计划已冻结，修改需要新版本和修订原因。'},
  research_idea_plan_snapshot_invalid: {category: 'degraded', message: '保存的方法计划或冻结回执校验失败。'},
  research_idea_plan_not_found: {category: 'not_found', message: '方法计划版本不存在。'},
  research_project_not_found: {category: 'not_found', message: '科研项目不存在。'},
  research_artifact_not_found: {category: 'not_found', message: 'Idea Canvas 工件不存在。'},
  research_idea_canvas_required: {category: 'not_found', message: '此工件尚无已保存的 Idea Canvas。'},
  research_idea_canvas_artifact_required: {category: 'validation', message: '方法计划需要 Idea Canvas 工件。'},
  research_idea_plan_project_mismatch: {category: 'permission', message: '计划或 Idea Canvas 不属于当前项目。'},
  research_project_archived: {category: 'permission', message: '项目已归档，方法计划仅可阅读。'},
  research_human_required: {category: 'permission', message: '保存与冻结方法计划需要有效的人工窗口身份。'},
  research_human_project_mismatch: {category: 'permission', message: '人工窗口身份与当前项目不一致。'},
  research_evidence_project_mismatch: {category: 'permission', message: '计划证据不属于当前项目。'},
  research_evidence_not_found: {category: 'not_found', message: '计划引用的证据不存在。'},
  research_evidence_integrity_invalid: {category: 'degraded', message: '计划引用的证据校验失败。'},
  research_evidence_reference_superseded: {category: 'conflict', message: '计划引用的证据已失效，需要重新核查。'}
};

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
