import type { ChatStartRunRequest, WorkflowHint } from '../../../shared/types';
import { buildPromptBlocks, serializePromptBlocks } from './context/prompt-blocks';

export const BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW = [
  '',
  '本轮工作流：创建后台任务。',
  '任务继承当前聊天已启用的 MCP/skills；需要时直接调用工具或读取 /skills/。',
  '先调用 resolve_background_task_time，再用其 trigger 调用 propose_background_task，最后用 previewId 调用 schedule_background_task。',
  '当前回合只创建任务，不执行定时目标。',
  '中文时段：早上7点=07:00，晚上9点=21:00，中午1点=13:00，晚上12点=00:00。',
  'cronExpression 为五段；nextRunAt 为 UTC ISO。不得猜测，使用解析工具返回值。',
  'propose 只填 goal、trigger；workspacePath 等策略字段由 runtime 注入。/workspace/ 仅用于文件工具。',
  '没有 previewId 不得 schedule；时间不明确时先向用户确认。'
] as const;

export function buildSystemPrompt(input: {
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workspacePath: string | null;
  workflowHint: WorkflowHint;
}): string {
  return serializePromptBlocks(
    buildPromptBlocks({
      mode: 'run',
      enabledCapabilities: input.enabledCapabilities,
      workspacePath: input.workspacePath,
      workflowHint: input.workflowHint,
      tools: [],
      explicitSkillContexts: [],
      referencedFileContexts: []
    })
  );
}

export function createCapabilitySummary(enabledCapabilities: ChatStartRunRequest['enabledCapabilities']): string {
  const mcpServers =
    enabledCapabilities.mcpServers.length > 0 ? [...enabledCapabilities.mcpServers].sort().join(',') : 'none';
  const skills = enabledCapabilities.skills.length > 0 ? [...enabledCapabilities.skills].sort().join(',') : 'none';
  return [
    `mcp=${mcpServers}`,
    `skills=${skills}`,
    'untrusted_context_policy=external_content_reference_only'
  ].join(';');
}
