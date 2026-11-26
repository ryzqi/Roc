import {tool, type StructuredToolInterface} from '@langchain/core/tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchToolDescriptor} from './research-tools';
import {prepareWritingContextRequestSchema, writingContextRequestSchema, writingContextResultSchema,
  writingGroundingResultSchema, writingImpactResultSchema} from '../../../shared/schemas/research-writing-context';

export const WRITING_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  {name: 'research_prepare_writing_context', scope: 'app', effectClass: 'external_call', riskLevel: 'low', executionScopes: ['main']},
  ...['research_check_draft_grounding', 'research_review_writing_impact'].map(name => ({name,
    scope: 'app' as const, effectClass: 'none' as const, riskLevel: 'low' as const,
    executionScopes: ['main', 'subagent'] as ResearchToolDescriptor['executionScopes']}))
];

export function createWritingTools(input: {projectId: string; signal: AbortSignal; capabilities: RocCapabilityRegistry}): StructuredToolInterface[] {
  const invoke = async (name: string, request: {artifactId: string}): Promise<unknown> => {
    input.signal.throwIfAborted();
    const result = await input.capabilities.invoke(`research.writing.${name}`, {...request, projectId: input.projectId}, input.signal);
    input.signal.throwIfAborted();
    return result;
  };
  const bound = <T extends {projectId: string; artifactId: string; contextId: string}>(result: T,
    request: {artifactId: string; contextId?: string}): T => {
    if (result.projectId !== input.projectId || result.artifactId !== request.artifactId ||
      request.contextId !== undefined && result.contextId !== request.contextId) throw new Error('research_writing_tool_binding_invalid');
    return result;
  };
  return [tool(async request => bound(writingContextResultSchema.parse(await invoke('prepareContext', request)), request), {
    name: 'research_prepare_writing_context',
    description: '正文生成前为指定章节准备持久写作依据：Wiki导航、准确原文、事实、Evidence、已审核Claim、反面证据和缺口。contextId可跨会话使用；incomplete不得冒充ready或自动确认科学支持。',
    schema: prepareWritingContextRequestSchema.omit({projectId: true})
  }), tool(async request => bound(writingGroundingResultSchema.parse(await invoke('checkGrounding', request)), request), {
    name: 'research_check_draft_grounding',
    description: '核验已存稿件与持久写作上下文，返回可定位到章节、段落、Claim的来源、数字、单位、条件和人工审核问题。检查不代替正式保存/导出闸门。',
    schema: writingContextRequestSchema.omit({projectId: true})
  }), tool(async request => bound(writingImpactResultSchema.parse(await invoke('reviewImpact', request)), request), {
    name: 'research_review_writing_impact',
    description: '读取来源、Wiki、Evidence、Claim和稿件变化的影响范围，提出需要复核的章节。只读分析，不改写人工正文或历史修订。',
    schema: writingContextRequestSchema.omit({projectId: true})
  })];
}
