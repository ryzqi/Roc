import type {z} from 'zod';
import {
  researchProposalCreateSchema, researchProposalGetSchema, researchProposalListSchema, researchProposalRejectSchema,
  researchProposalInspectionSchema, researchProposalListResultSchema
} from '../../../shared/schemas/research-proposals';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {RocErrorCategory} from '../../../shared/types';
import type {ResearchProposalService} from './proposal-service';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  create: {...descriptor('research.proposals.create', researchProposalCreateSchema, researchProposalInspectionSchema), effectReceipt: 'handler' as const},
  get: descriptor('research.proposals.get', researchProposalGetSchema, researchProposalInspectionSchema),
  list: descriptor('research.proposals.list', researchProposalListSchema, researchProposalListResultSchema),
  reject: descriptor('research.proposals.reject', researchProposalRejectSchema, researchProposalInspectionSchema)
};
export const researchProposalCapabilities = Object.values(capabilities);
export function registerResearchProposalCapabilities(context: RocPluginContext, repository: ResearchProposalService): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await action(input);}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.name === 'ZodError' || error instanceof SyntaxError ? 'research_proposal_contract_invalid' : error.message.split(':')[0];
        const detail = errors[code];
        if (detail === undefined) throw error;
        throw new RocDomainError({code, ...detail, retryable: false});
      }
    });
  }
  register(capabilities.create, input => repository.create(input));
  register(capabilities.get, input => repository.get(input));
  register(capabilities.list, input => repository.list(input));
  register(capabilities.reject, input => repository.reject(input));
}
const errors: Record<string, {message: string; category: RocErrorCategory}> = {
  research_proposal_contract_invalid: {message: '科研提案字段不符合对应领域合同。', category: 'validation'},
  research_proposal_operation_required: {message: '科研提案需要有效的 Agent 工具执行身份。', category: 'permission'},
  research_proposal_origin_invalid: {message: '科研提案无法核实当前运行来源。', category: 'permission'},
  research_proposal_capability_denied: {message: '当前运行能力清单未允许提交科研提案。', category: 'permission'},
  research_dispatch_parent_not_active: {message: '科研提案所属的 Agent 运行已停止。', category: 'permission'},
  research_dispatch_parent_revoked: {message: '科研提案所属运行已撤销。', category: 'permission'},
  research_dispatch_parent_binding_invalid: {message: '科研提案所属运行与项目不一致。', category: 'permission'},
  research_proposal_project_mismatch: {message: '科研提案或材料不属于当前项目。', category: 'permission'},
  research_proposal_artifact_kind_mismatch: {message: '科研提案类型不适用于此工件。', category: 'validation'},
  research_proposal_target_mismatch: {message: '科研提案内容与目标工件不一致。', category: 'validation'},
  research_proposal_baseline_changed: {message: '提案依据的工件版本已变化，请重新生成。', category: 'conflict'},
  research_proposal_material_changed: {message: '提案引用的领域材料已变化或无法核实。', category: 'conflict'},
  research_proposal_parent_changed: {message: '提案引用的上一个审核版本已变化。', category: 'conflict'},
  research_proposal_request_conflict: {message: '提案重试内容或执行身份与已保存请求不同。', category: 'conflict'},
  research_proposal_hash_mismatch: {message: '提案版本与当前选择不一致。', category: 'conflict'},
  research_proposal_snapshot_invalid: {message: '科研提案保存记录完整性校验失败。', category: 'degraded'},
  research_proposal_not_found: {message: '科研提案不存在。', category: 'not_found'},
  research_project_not_found: {message: '科研项目不存在。', category: 'not_found'},
  research_artifact_not_found: {message: '科研工件不存在。', category: 'not_found'},
  research_project_archived: {message: '归档项目的科研提案仅可阅读。', category: 'permission'},
  research_human_required: {message: '拒绝科研提案需要当前窗口的人工操作。', category: 'permission'},
  research_human_project_mismatch: {message: '人工操作身份不属于当前项目。', category: 'permission'}
};
