import {tool} from 'langchain';
import {z} from 'zod';
import type {StructuredToolInterface} from '@langchain/core/tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import {getCapabilityOperationContext} from '../../kernel/capability-operation-context';
import type {ResearchToolDescriptor} from './research-tools';
import {
  researchProposalCreateSchema, researchProposalGetSchema, researchProposalListSchema,
  researchProposalInspectionSchema, researchProposalListResultSchema,
  type ResearchProposalInspection
} from '../../../shared/schemas/research-proposals';

export const RESEARCH_PROPOSAL_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  {name: 'research_propose_change', scope: 'app', effectClass: 'workspace_mutation', riskLevel: 'low', executionScopes: ['main']},
  {name: 'research_read_proposals', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: ['main', 'subagent']}
];
const createSchema = z.strictObject(researchProposalCreateSchema.shape).omit({projectId: true, requestId: true});
const readRequestSchema = z.discriminatedUnion('action', [
  researchProposalGetSchema.omit({projectId: true}).extend({action: z.literal('get')}),
  researchProposalListSchema.omit({projectId: true}).extend({action: z.literal('list')})
]);
const readSchema = z.strictObject({
  action: z.enum(['get', 'list']).describe('get 仅传 proposalId；list 传 offset/limit，可筛选 artifactId/status/kind。'),
  proposalId: researchProposalGetSchema.shape.proposalId.optional(),
  ...researchProposalListSchema.omit({projectId: true}).partial().shape
}).pipe(readRequestSchema);

export function createResearchProposalTools(input: {
  projectId: string; signal: AbortSignal; capabilities: RocCapabilityRegistry;
}): StructuredToolInterface[] {
  const invoke = async (name: string, request: object): Promise<unknown> => {
    input.signal.throwIfAborted();
    const result = await input.capabilities.invoke(`research.proposals.${name}`, {...request, projectId: input.projectId}, input.signal);
    input.signal.throwIfAborted();
    return result;
  };
  const inspect = (value: unknown): ResearchProposalInspection => {
    const result = researchProposalInspectionSchema.parse(value);
    if (result.snapshot.request.projectId !== input.projectId) throw new Error('research_proposal_project_mismatch');
    return result;
  };
  return [
    tool(async request => {
      const operation = getCapabilityOperationContext();
      if (operation?.toolName !== 'research_propose_change') throw new Error('research_proposal_tool_context_required');
      const parsed = researchProposalCreateSchema.parse({...request, projectId: input.projectId, requestId: operation.idempotencyKey});
      const result = inspect(await invoke('create', parsed));
      return {...result, reviewTarget: {projectId: input.projectId, artifactId: result.snapshot.request.artifactId,
        expectedVersion: result.snapshot.request.expectedArtifactVersion},
      nextStep: '在目标工件检查器的对应审核表单中查看提案并明确选择填入；保存仍需人工审核。提案没有批准、冻结或修改正文。'};
    }, {
      name: 'research_propose_change', schema: createSchema,
      description: '为当前项目保存可审阅的科研变更提案：方法计划、引用直接性、数值/图表映射、回复矩阵、期刊规则或实验指标。'
        + '先用检查工具读取真实工件版本、报告哈希与父审核；payload 使用原审核结构，额外 basis 只列实际引用的其他工件版本。'
        + '运行来源和请求身份由宿主绑定，相同操作重试复用回执；不执行人工批准、冻结、领域保存或实验。'
        + '提案字段必须来自已读取的证据，不能为填满表单猜造统计量、人工观察声明或来源。返回 proposal ID、hash 和检查器位置。'
    }),
    tool(async target => {
      const {action, ...request} = target;
      if (action === 'get') return inspect(await invoke('get', request));
      const result = researchProposalListResultSchema.parse(await invoke('list', request));
      result.items.forEach(inspect);
      return {...result, nextOffset: target.offset + result.items.length < result.total ? target.offset + result.items.length : null};
    }, {
      name: 'research_read_proposals', schema: readSchema,
      description: '按准确ID读取科研提案，或按工件与状态分页列出。返回真实来源、版本依据、拒绝理由和当前失效原因。'
        + 'pending只表示未拒绝，current只表示依据未变化；两者都不代表人工采纳或科学批准。读取不修改审核。'
    })
  ];
}
