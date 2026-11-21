import {tool} from 'langchain';
import type {StructuredToolInterface} from '@langchain/core/tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchToolDescriptor} from './research-tools';
import {researchImpactInspectSchema, researchImpactReportSchema} from '../../../shared/schemas/research-impact';

export const RESEARCH_IMPACT_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  {name: 'research_inspect_impact', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: ['main', 'subagent']}
];
export function createResearchImpactTools(input: {projectId: string; signal: AbortSignal; capabilities: RocCapabilityRegistry}): StructuredToolInterface[] {
  return [tool(async request => {
    input.signal.throwIfAborted();
    const report = researchImpactReportSchema.parse(await input.capabilities.invoke('research.impact.inspect',
      {...request, projectId: input.projectId}, input.signal));
    input.signal.throwIfAborted();
    return {...report, nextStep: '在工件检查器查看影响与定向修复，确认目标和每个阶段的新输入；然后沿原任务创建新运行。旧批准不能重绑到新内容。'};
  }, {name: 'research_inspect_impact', schema: researchImpactInspectSchema.omit({projectId: true}),
    description: '读取准确工件、证据或结果版本的记录依赖。报告区分直接材料关系和宽泛的运行上下文，并列出受影响与保留的工件。'
      + '只覆盖已记录关系，不证明科学上无关，也不撤销历史交付。提议定向修复前先读取此报告；人工确认按报告哈希及明确输入继续。'})];
}
