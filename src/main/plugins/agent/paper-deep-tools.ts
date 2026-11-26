import {tool, type StructuredToolInterface} from '@langchain/core/tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchToolDescriptor} from './research-tools';
import {paperDeepKnowledgeRequestSchema} from '../../../shared/schemas/research-paper-deep-knowledge';
import {paperCardKnowledgeReadRequestSchema, paperCardKnowledgeSchema} from '../../../shared/schemas/research-paper-card-knowledge';

export const PAPER_DEEP_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  {name: 'research_request_paper_deep_knowledge', scope: 'app', effectClass: 'external_call', riskLevel: 'low', executionScopes: ['main']},
  {name: 'research_read_paper_deep_knowledge', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: ['main', 'subagent']}
];
export function createPaperDeepTools(input: {projectId: string; signal: AbortSignal; capabilities: RocCapabilityRegistry}): StructuredToolInterface[] {
  const invoke = async (name: string, request: object): Promise<unknown> => {
    input.signal.throwIfAborted();
    const result = await input.capabilities.invoke(name, {...request, projectId: input.projectId}, input.signal);
    input.signal.throwIfAborted();
    return result;
  };
  return [tool(request => invoke('research.knowledge.deepRequest', request), {
    name: 'research_request_paper_deep_knowledge',
    description: '针对已解析论文按阅读/写作/比较目标生成深读知识。优先指定相关章节或科学对象；返回可重试作业，重复请求复用有效批次。生成内容仍未人工审核。',
    schema: paperDeepKnowledgeRequestSchema.omit({projectId: true})
  }), tool(async request => {
    const result = paperCardKnowledgeSchema.parse(await invoke('research.knowledge.deepRead', request));
    return {...result, scientificApproval: 'unreviewed', instruction: '保留作者陈述、来源推导、模型推断及unknown区分；正式写作须重新验证原文及Evidence/Claim。'};
  }, {name: 'research_read_paper_deep_knowledge',
    description: '读取当前论文深读结果、来源与完整原始对象及缺失条件；旧出版可保留可见，但stale不得作当前证据。',
    schema: paperCardKnowledgeReadRequestSchema.omit({projectId: true})})];
}
