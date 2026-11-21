import {tool} from 'langchain';
import {z} from 'zod';
import type {StructuredToolInterface} from '@langchain/core/tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchToolDescriptor} from './research-tools';
import {researchResultDerivationRequestSchema, researchResultDerivationSchema} from '../../../shared/schemas/research-result-derivation';
import {researchResultFigureSourceRequestSchema, researchResultFigureSourceSchema} from '../../../shared/schemas/research-result-figure-source';

export const RESEARCH_RESULT_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  {name: 'research_derive_results', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: ['main', 'subagent']},
  {name: 'research_prepare_result_figure', scope: 'workspace', effectClass: 'workspace_mutation', riskLevel: 'low', executionScopes: ['main']}
];

export function createResearchResultTools(input: {projectId: string; signal: AbortSignal; capabilities: RocCapabilityRegistry}): StructuredToolInterface[] {
  const invoke = async <S extends z.ZodType>(action: string, request: object, schema: S): Promise<z.output<S>> => {
    input.signal.throwIfAborted();
    const result = await input.capabilities.invoke(`research.resultDerivation.${action}`, {...request, projectId: input.projectId}, input.signal);
    input.signal.throwIfAborted();
    return schema.parse(result);
  };
  return [
    tool(request => invoke('preview', request, researchResultDerivationSchema), {
      name: 'research_derive_results', schema: z.strictObject(researchResultDerivationRequestSchema.shape).omit({projectId: true}),
      description: '根据经过核验的实际结果回执生成指标、图源、Methods 草稿、正文数值差异和审稿回复草稿。'
        + '回执 ID 和哈希来自 research_inspect_workflow。比对旧结果时传真实 previous，指定正文和版本才能给出位置。'
        + '保持统计方法和未记录的不确定性，从已核对的映射得出替换。正文差异在稿件同步中采纳，回复通过现有提案审核。'
    }),
    tool(request => invoke('prepareFigure', request, researchResultFigureSourceSchema), {
      name: 'research_prepare_result_figure', schema: researchResultFigureSourceRequestSchema.omit({projectId: true}),
      description: '保存由准确结果和哈希生成的 Vega-Lite 图源。复制 research_derive_results 返回的 sourceHash 和同一 metricIds。'
        + '用返回的 sourcePath 和 expectedSourceHash 让图稿阶段渲染；相同字节复用同一文件。'
    })
  ];
}
