import type { BackgroundTaskPreviewRequest } from './types';

export const PROPOSE_TOOL_NAME = 'propose_background_task';

export const PROPOSE_REQUIRED_KEYS = ['goal', 'trigger', 'workspacePath'] as const;

export const PROPOSE_OPTIONAL_KEYS = ['allowedActions', 'forbiddenActions', 'notificationPolicy'] as const;

export const PROPOSE_MODEL_KEYS = ['goal', 'trigger'] as const;

export const PROPOSE_RUNTIME_DEFAULTS = {
  allowedActions: [] as string[],
  forbiddenActions: [] as string[],
  notificationPolicy: 'failures_and_confirmations'
} as const;

export const FORBIDDEN_MODEL_TOP_LEVEL_KEYS = [
  'allowedActions',
  'forbiddenActions',
  'notificationPolicy',
  'enabledCapabilities',
  'failurePolicy'
] as const;

export const FORBIDDEN_TRIGGER_KEYS = ['schedule', 'expr', 'expression', 'cron', 'when', 'time'] as const;

export const MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE = {
  goal: '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件',
  trigger: {
    type: 'cron',
    cronExpression: '40 19 * * *',
    nextRunAt: '2026-05-26T11:40:00.000Z'
  }
} as const;

export const BACKGROUND_TASK_PROPOSE_EXAMPLE = {
  ...MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE,
  trigger: {
    ...MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE.trigger,
    description: '每天晚上 7:40 触发'
  },
  workspacePath: 'F:\\Code\\Roc',
  ...PROPOSE_RUNTIME_DEFAULTS
} as const satisfies Omit<BackgroundTaskPreviewRequest, 'failurePolicy' | 'enabledCapabilities'>;

export const PROPOSE_TOOL_DESCRIPTION = [
  '为后台或定时任务生成 preview（草稿），但不实际创建。',
  '模型只填写 goal 和 trigger；workspacePath 由 runtime 注入。',
  '不要填写 allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy。',
  'trigger.type 只能是 manual、once 或 cron。',
  'trigger.description 可省略；runtime 会补齐展示说明。',
  'cron trigger 使用五段 cronExpression 和 UTC ISO nextRunAt。',
  '缺少明确时间时不要改用 manual；应请求澄清。',
  '只有用户明确要求手动执行、按需执行或不设定时间时，才使用 manual。',
  '本工具返回 previewId 与 preview 内容；要实际创建任务，必须随后调用 schedule_background_task(previewId)。'
].join('\n');

/**
 * @deprecated 自 2026-05-28 forge guardrails Phase 3 起，新代码路径应直接传用户描述作为 input，
 * 并在 ChatStartRunRequest 中设置 workflowHint='propose_background_task'。本函数保留兼容期。
 */
export function buildTaskProposalPrompt(input: { description: string; workspacePath: string }): string {
  return [
    `必须调用 ${PROPOSE_TOOL_NAME}。`,
    '只提交一次 tool call，不要输出普通文本。',
    '创建任务不是预览任务，不要请求批准。',
    `当前工作区：${input.workspacePath}`,
    '新 DeepAgents 创建流中 workspacePath 由 runtime 注入；本兼容 prompt 中的 workspacePath 只用于旧调用形状。',
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
    '不要添加 allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy；runtime 会自动设置默认值。',
    '不要把 runtime-only 字段写入 JSON 形状。',
    '只有用户明确要求手动执行、按需执行或不设定时间时，才使用 manual。',
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

const minimalExampleKeys = Object.keys(MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE).sort();
const expectedModelKeys = [...PROPOSE_MODEL_KEYS].sort();
if (minimalExampleKeys.join('\0') !== expectedModelKeys.join('\0')) {
  throw new Error('MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE key set does not match model-visible keys.');
}
