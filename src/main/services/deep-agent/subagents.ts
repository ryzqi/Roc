import type { RuntimeSubagent, StringDynamicStructuredTool } from './types';

const asyncTaskToolNames = [
  'start_async_task',
  'check_async_task',
  'update_async_task',
  'cancel_async_task',
  'list_async_tasks'
] as const;

const reservedSubagentNames = new Set<string>(asyncTaskToolNames);

export function createRunSubagents(input: {
  webReadTool: StringDynamicStructuredTool;
  researchSkillSources?: readonly string[];
}): RuntimeSubagent[] {
  const subagents: RuntimeSubagent[] = [];
  subagents.push({
    name: 'research',
    description: '检索公开资料并读取网页，整理带来源边界的结论。',
    systemPrompt:
      '你是 Roc 的资料检索子代理。优先使用 web_read 读取来源原文，只输出与问题直接相关的结论，区分外部事实和你的判断，并标明哪些内容来自外部资料。',
    tools: [input.webReadTool],
    skills: [...(input.researchSkillSources ?? [])]
  });
  validateRuntimeSubagents(subagents);
  return subagents;
}

export function validateRuntimeSubagents(subagents: readonly RuntimeSubagent[]): void {
  const seen = new Set<string>();
  for (const subagent of subagents) {
    if (reservedSubagentNames.has(subagent.name)) {
      throw new Error(`subagent_name_reserved:${subagent.name}`);
    }
    if (seen.has(subagent.name)) {
      throw new Error(`subagent_name_duplicate:${subagent.name}`);
    }
    seen.add(subagent.name);
    if (subagent.description.trim().length === 0) {
      throw new Error(`subagent_description_empty:${subagent.name}`);
    }
    if ('graphId' in subagent && subagent.graphId.trim().length === 0) {
      throw new Error(`subagent_graph_id_empty:${subagent.name}`);
    }
  }
}
