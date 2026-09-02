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
    description: '读取公开资料并整理带来源的结论。',
    systemPrompt:
      '你是 Roc 的检索子代理。优先用 web_read 读取原文；只输出相关结论，区分外部事实与判断，并标明来源。',
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
