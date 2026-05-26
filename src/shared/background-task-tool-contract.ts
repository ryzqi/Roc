import type { BackgroundTaskPreviewRequest } from './types';

export const PROPOSE_TOOL_NAME = 'propose_background_task';

export const PROPOSE_REQUIRED_KEYS = ['goal', 'trigger', 'workspacePath'] as const;

export const PROPOSE_OPTIONAL_KEYS = ['allowedActions', 'forbiddenActions', 'notificationPolicy'] as const;

export const FORBIDDEN_TRIGGER_KEYS = ['schedule', 'expr', 'expression', 'cron', 'when', 'time'] as const;

export const BACKGROUND_TASK_PROPOSE_EXAMPLE = {
  goal: '每天 21:50 抓取 AI 最新新闻并写入当前工作区的 docx 文件',
  trigger: {
    type: 'cron',
    description: '每天 21:50 触发',
    cronExpression: '50 21 * * *',
    nextRunAt: '2026-05-25T13:50:00.000Z'
  },
  workspacePath: 'F:\\Code\\Roc',
  allowedActions: [],
  forbiddenActions: [],
  notificationPolicy: 'failures_and_confirmations'
} as const satisfies Omit<BackgroundTaskPreviewRequest, 'failurePolicy' | 'enabledCapabilities'>;

export const PROPOSE_TOOL_DESCRIPTION = [
  '直接创建后台或定时任务。',
  '只使用 goal、trigger、workspacePath、allowedActions、forbiddenActions。',
  'trigger.type 只能是 manual、once 或 cron。',
  'cron trigger 使用 cronExpression 和 UTC ISO nextRunAt。',
  '无法确定触发方式时使用 manual。'
].join('\n');

export function buildTaskProposalPrompt(input: { description: string; workspacePath: string }): string {
  return [
    `必须调用 ${PROPOSE_TOOL_NAME}。`,
    `当前工作区：${input.workspacePath}`,
    'trigger.type 只能是 manual、once 或 cron。',
    '仅使用以下三种 JSON 形状之一：',
    '',
    `{ "goal": string, "trigger": { "type": "manual", "description": string }, "workspacePath": "${input.workspacePath}" }`,
    '',
    `{ "goal": string, "trigger": { "type": "once", "description": string, "nextRunAt": "<UTC ISO>" }, "workspacePath": "${input.workspacePath}" }`,
    '',
    `{ "goal": string, "trigger": { "type": "cron", "description": string, "cronExpression": "m h dom mon dow", "nextRunAt": "<UTC ISO>" }, "workspacePath": "${input.workspacePath}" }`,
    '',
    'cronExpression 按本机时区执行；nextRunAt 必须是 UTC ISO，含 T 与 Z。',
    '无法确定触发方式时，使用 manual。',
    '',
    '用户描述：',
    input.description
  ].join('\n');
}

const exampleKeys = Object.keys(BACKGROUND_TASK_PROPOSE_EXAMPLE).sort();
const expectedKeys = [...PROPOSE_REQUIRED_KEYS, ...PROPOSE_OPTIONAL_KEYS].sort();
if (exampleKeys.join('\0') !== expectedKeys.join('\0')) {
  throw new Error('BACKGROUND_TASK_PROPOSE_EXAMPLE key set does not match propose tool contract keys.');
}
