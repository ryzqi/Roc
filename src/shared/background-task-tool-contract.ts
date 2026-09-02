import type { BackgroundTaskPreviewRequest } from './types';

export const PROPOSE_TOOL_NAME = 'propose_background_task';

export const PROPOSE_REQUIRED_KEYS = ['goal', 'trigger', 'workspacePath'] as const;

export const PROPOSE_OPTIONAL_KEYS = ['allowedActions', 'forbiddenActions', 'notificationPolicy'] as const;

const PROPOSE_MODEL_KEYS = ['goal', 'trigger'] as const;

const PROPOSE_RUNTIME_DEFAULTS = {
  allowedActions: [] as string[],
  forbiddenActions: [] as string[],
  notificationPolicy: 'failures_and_confirmations'
} as const;

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
  '生成后台任务 preview，不实际创建。',
  '只填写 goal 和 trigger；workspacePath 与策略字段由 runtime 注入。',
  'trigger.type 为 manual、once 或 cron；description 可省略。',
  'cron 使用五段 cronExpression 和 UTC ISO nextRunAt。',
  '时间不明确时请求澄清，不要改用 manual；manual 仅用于用户明确要求手动执行。',
  '返回 previewId；要创建任务，随后调用 schedule_background_task(previewId)。'
].join('\n');

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
