import type {StructuredToolInterface} from '@langchain/core/tools';
import {tool} from 'langchain';
import {z} from 'zod';
import type {ResearchToolDescriptor} from './research-tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import {getCapabilityOperationContext} from '../../kernel/capability-operation-context';
import type {ExecutionGrantBroker} from '../../services/deep-agent/execution-grant-broker';
import {withReviewSearchDispatch} from '../../services/research-review-dispatch-context';
import {withReviewSearchOwner} from '../../services/research-review-owner-context';
import type {RunCapabilityManifestV1} from '../../../shared/types';
import {
  researchReviewSearchStartSchema, researchReviewSearchGetSchema, researchReviewSearchCancelSchema,
  type ResearchReviewSearchStart, type ResearchReviewSearchCancel, type ResearchReviewOwnedSearchInspection
} from '../../../shared/schemas/research-review-search';
import type {ResearchReviewLink, ResearchReviewLinksArtifact} from '../../../shared/schemas/research-review-links';

export const REVIEW_QUERY_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  {name: 'research_review_execute_query', scope: 'app', effectClass: 'external_call', riskLevel: 'medium', executionScopes: ['main']},
  {name: 'research_review_get_query', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: ['main']},
  {name: 'research_review_cancel_query', scope: 'app', effectClass: 'external_call', riskLevel: 'low', executionScopes: ['main']}
];

export type ReviewQueryDispatch =
  | {action: 'start'; request: ResearchReviewSearchStart}
  | {action: 'get'; request: z.infer<typeof researchReviewSearchGetSchema>}
  | {action: 'cancel'; request: ResearchReviewSearchCancel};
export type DispatchReviewQuery = (query: ReviewQueryDispatch) => Promise<ResearchReviewOwnedSearchInspection>;

const {projectId: _projectId, requestId: _requestId, ...queryFields} = researchReviewSearchStartSchema.shape;
const executeSchema = z.object(queryFields).strict().refine(
  value => (value.retryOf === null) === (value.expectedRetrySnapshotHash === null), 'review_retry_snapshot_required'
);

export function createReviewQueryTools(input: {
  projectId: string;
  signal: AbortSignal;
  dispatchReviewQuery: DispatchReviewQuery;
}): StructuredToolInterface[] {
  const invoke = async (query: ReviewQueryDispatch): Promise<[unknown, ResearchReviewLinksArtifact]> => {
    input.signal.throwIfAborted();
    const result = await input.dispatchReviewQuery(query);
    input.signal.throwIfAborted();
    const snapshot = result.search.snapshot;
    const link: ResearchReviewLink = {
      projectId: snapshot.request.projectId, title: '只读核查本次查询的冻结协议',
      target: {kind: 'protocol', versionId: snapshot.request.versionId,
        expectedVersionHash: snapshot.protocolVersionHash, expectedFreezeHash: snapshot.request.expectedFreezeHash}
    };
    return [{...result, reviewLinks: [link]}, {kind: 'roc_review_receipt_links', links: [link]}];
  };
  return [
    tool(request => invoke({action: 'start', request: {
      projectId: input.projectId, requestId: operationId('research_review_execute_query'), ...request
    }}), {
      name: 'research_review_execute_query', responseFormat: 'content_and_artifact',
      description: '执行人工已冻结协议中的准确数据库查询。先读协议，使用返回的版本和冻结哈希及数据库/查询索引；'
        + '查询式、分页和时间范围由冻结协议决定，不能自行修改。首次执行明确 retryOf=null、expectedRetrySnapshotHash=null；'
        + '另一次尝试必须引用原查询 ID 和原 snapshotHash。请求和父任务身份由主进程绑定；相同操作重试返回原执行。'
        + '返回真实查询 ID/状态/任务归属；running 时用 research_review_get_query 查询，partial/failed/cancelled/interrupted 不是完整检索。'
        + '不导入文献、不修改协议、不提交人工筛选决定；原始池随后由 research_review_read 的 search_pool 准确分页读取。',
      schema: executeSchema
    }),
    tool(request => invoke({action: 'get', request: {...request, projectId: input.projectId}}), {
      name: 'research_review_get_query', responseFormat: 'content_and_artifact',
      description: '读取本轮主助手实际拥有的准确综述查询 ID，返回持久化状态、原始来源回执、覆盖情况和任务关联。'
        + '完成状态必须为 complete 且 coverageComplete=true；partial 或失败保留真实原因。读取不发起检索，不创建任务。'
        + '其他聊天或人工查询用项目只读 research_review_read 查看，不能据此取得拥有者权限。',
      schema: researchReviewSearchGetSchema.omit({projectId: true})
    }),
    tool(request => invoke({action: 'cancel', request: {
      projectId: input.projectId, requestId: operationId('research_review_cancel_query'), ...request
    }}), {
      name: 'research_review_cancel_query', responseFormat: 'content_and_artifact',
      description: '取消本轮主助手拥有的准确综述查询。先读取当前查询，用返回的 revision 和明确原因提交。'
        + '取消意图先持久化再中断真实请求；返回 cancelling 后继续读取到真实终态。相同操作重试复用原取消回执，'
        + '不能取消其他聊天、人工查询或整个项目。',
      schema: researchReviewSearchCancelSchema.omit({projectId: true, requestId: true})
    })
  ];
}

/** Only the main harness supplies this execution context. Tool arguments carry no authority. */
export async function dispatchReviewQuery(input: {
  query: ReviewQueryDispatch;
  projectId: string;
  runId: string;
  threadId: string;
  manifest: RunCapabilityManifestV1;
  broker: ExecutionGrantBroker;
  capabilities: RocCapabilityRegistry;
  signal: AbortSignal;
}): Promise<ResearchReviewOwnedSearchInspection> {
  input.signal.throwIfAborted();
  const {query} = input;
  if (query.request.projectId !== input.projectId) throw new Error('research_review_project_mismatch');
  const binding = {runId: input.runId, threadId: input.threadId, projectId: input.projectId, manifest: input.manifest};
  switch (query.action) {
    case 'start': {
      const reference = input.broker.issueReviewSearchDispatch({...binding, request: query.request});
      return await withReviewSearchDispatch({reference, signal: input.signal}, () =>
        input.capabilities.invoke('research.reviewSearch.startOwned', query.request));
    }
    case 'get': {
      const owner = input.broker.authorizeReviewSearchOwner({...binding, toolName: 'research_review_get_query'});
      return await withReviewSearchOwner(owner, () =>
        input.capabilities.invoke('research.reviewSearch.getOwned', query.request));
    }
    case 'cancel': {
      const owner = input.broker.authorizeReviewSearchOwner({...binding, toolName: 'research_review_cancel_query'});
      return await withReviewSearchOwner(owner, () =>
        input.capabilities.invoke('research.reviewSearch.cancelOwned', query.request));
    }
  }
}

function operationId(toolName: string): string {
  const operation = getCapabilityOperationContext();
  if (operation === undefined || operation.toolName !== toolName) throw new Error('research_review_query_tool_context_required');
  return operation.idempotencyKey;
}
