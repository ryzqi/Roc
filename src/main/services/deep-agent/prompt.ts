import type { ChatStartRunRequest, WorkflowHint } from '../../../shared/types';
import { buildPromptBlocks, serializePromptBlocks } from './context/prompt-blocks';

export const BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW = [
  '',
  '本轮工作流：创建后台任务。',
  '本轮后台任务继承当前主聊天已启用的 MCP 和 skills；需要检索、读取网页或使用 skill 时直接调用可用工具/读取 /skills/。',
  '你负责解析用户目标和触发时间；先调用 resolve_background_task_time，再用返回的 trigger 调用 propose_background_task 创建 preview，最后调用 schedule_background_task 落地。',
  '创建后台任务不是立即执行任务目标；不要把用户要求定时执行的文件、shell 或业务动作在当前回合直接完成。',
  '中文时段解析约定：早上7点=07:00，晚上9点=21:00，中午1点=13:00，晚上12点=00:00。',
  'cron trigger 使用五段 cronExpression；nextRunAt 必须是 UTC ISO 字符串。',
  '不要自行猜测 nextRunAt；使用 resolve_background_task_time 返回的 trigger。',
  'propose_background_task 只填写 goal 和 trigger；不要填写 workspacePath、allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy。',
  '后台任务 workspacePath 由 runtime 注入当前 Windows 工作区路径。',
  'Deep Agents 文件工具使用 /workspace/...；不要把 /workspace/ 当作后台任务 workspacePath。',
  '只有 propose_background_task 返回 previewId 后才能调用 schedule_background_task；缺少 previewId 时报告失败，不要编造。',
  '如果触发时间仍不确定，直接请求用户补充明确时间，不要调用 propose_background_task。'
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
      explicitSkillContexts: []
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
