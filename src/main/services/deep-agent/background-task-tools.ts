import { existsSync } from 'node:fs';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  EnabledCapabilities,
  TaskDetail,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import type { StringDynamicStructuredTool } from './types';
import { PROPOSE_TOOL_DESCRIPTION, PROPOSE_TOOL_NAME } from '../../../shared/background-task-tool-contract';
import { RocDomainError } from '../errors';
import { PreviewStore, RocToolResolutionError } from '../forge-guardrails';
import { parseCronExpression } from '../../plugins/task/cron-parser';

const manualTriggerSchema = z.strictObject({
  type: z.literal('manual').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).describe('展示给用户的触发说明，单句中文。')
});

const onceTriggerSchema = z.strictObject({
  type: z.literal('once').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).describe('展示给用户的触发说明，单句中文。'),
  nextRunAt: z.string().datetime().describe('UTC ISO 时间戳（含 T 与 Z），调度器下次触发时间。')
});

const cronTriggerSchema = z.strictObject({
  type: z.literal('cron').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).describe('展示给用户的触发说明，单句中文。'),
  cronExpression: z.string().min(1).describe('五段 cron，按本机时区执行，例如 50 21 * * *。'),
  nextRunAt: z.string().datetime().describe('UTC ISO 时间戳（含 T 与 Z），调度器下次触发时间。')
});

const triggerSchema = z
  .discriminatedUnion('type', [manualTriggerSchema, onceTriggerSchema, cronTriggerSchema])
  .describe('触发类型：manual / once / cron。');

const modelManualTriggerSchema = z.strictObject({
  type: z.literal('manual').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).optional().describe('展示给用户的触发说明，单句中文；可省略，由 runtime 补齐。')
});

const modelOnceTriggerSchema = z.strictObject({
  type: z.literal('once').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).optional().describe('展示给用户的触发说明，单句中文；可省略，由 runtime 补齐。'),
  nextRunAt: z.string().datetime().describe('UTC ISO 时间戳（含 T 与 Z），调度器下次触发时间。')
});

const modelCronTriggerSchema = z.strictObject({
  type: z.literal('cron').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).optional().describe('展示给用户的触发说明，单句中文；可省略，由 runtime 补齐。'),
  cronExpression: z.string().min(1).describe('五段 cron，按本机时区执行，例如 50 21 * * *。'),
  nextRunAt: z.string().datetime().describe('UTC ISO 时间戳（含 T 与 Z），调度器下次触发时间。')
});

const modelTriggerSchema = z
  .discriminatedUnion('type', [modelManualTriggerSchema, modelOnceTriggerSchema, modelCronTriggerSchema])
  .describe('触发类型：manual / once / cron。');

const enabledCapabilitiesSchema = z.object({
  mcpServers: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([])
});

export const proposeToolInputSchema = z.strictObject({
  goal: z.string().min(1).max(500).describe('后台任务目标，单句中文描述。'),
  trigger: modelTriggerSchema,
  workspacePath: z.string().min(1).optional().describe('兼容旧模型输出；实际后台任务 workspacePath 始终由 runtime 注入。')
});

const fullProposeInputSchema = z.strictObject({
  goal: z.string().min(1).max(500).describe('后台任务目标，单句中文描述。'),
  trigger: triggerSchema,
  workspacePath: z.string().min(1).describe('Windows 绝对工作区路径，由 runtime 注入。')
});

export const proposeInputSchema = fullProposeInputSchema.extend({
  allowedActions: z.array(z.string()).default([]).describe('动作边界字符串数组，可为空。'),
  forbiddenActions: z.array(z.string()).default([]).describe('动作边界字符串数组，可为空。'),
  notificationPolicy: z.literal('failures_and_confirmations').default('failures_and_confirmations'),
  enabledCapabilities: enabledCapabilitiesSchema.nullable().optional()
});

const updateInputSchema = z.object({
  taskId: z.string().min(1),
  patch: proposeInputSchema.partial(),
  reason: z.string().min(1)
});

const cancelInputSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1)
});

const readInputSchema = z.strictObject({
  taskId: z.string().min(1)
});

const scheduleInputSchema = z.strictObject({
  previewId: z.string().min(1).describe('propose_background_task 返回的 previewId。')
});

const SCHEDULE_TOOL_DESCRIPTION = [
  '将 propose_background_task 的 preview 落地并加入调度。',
  '必须先取得 previewId。',
  '返回真实 taskId。'
].join('\n');

type BackgroundTaskToolDependencies = {
  taskAdapter: BackgroundTaskToolTaskAdapter;
  schedulerAdapter: BackgroundTaskToolSchedulerAdapter;
  enabledCapabilities?: EnabledCapabilities;
  previewStore: PreviewStore;
  runtimeWorkspacePath: string | null;
  toolMode?: 'all' | 'change';
};

type Awaitable<T> = T | Promise<T>;

type BackgroundTaskToolTaskAdapter = {
  createBackgroundTask(request: BackgroundTaskPreviewRequest): Awaitable<{ id: string; threadId: string; nextRunAt: string | null; status?: string }>;
  createBackgroundTaskPreview(request: BackgroundTaskPreviewRequest): Awaitable<BackgroundTaskPreview>;
  readBackgroundTask(taskId: string): Awaitable<TaskDetail>;
  updateBackgroundTask(request: UpdateBackgroundTaskRequest): Awaitable<{ id: string; threadId: string; nextRunAt: string | null }>;
  cancelBackgroundTask(taskId: string): Awaitable<{ id: string; threadId: string; status: string }>;
};

type BackgroundTaskToolSchedulerAdapter = {
  refreshTask(task: { id: string }): void;
  registerTask(task: { id: string }): void;
  unregisterTask(taskId: string): void;
};

export function createBackgroundTaskTools(input: BackgroundTaskToolDependencies): StringDynamicStructuredTool[] {
  const creationTools = [
    new DynamicStructuredTool<
      typeof proposeToolInputSchema,
      z.infer<typeof proposeToolInputSchema>,
      z.infer<typeof proposeToolInputSchema>,
      string
    >({
      name: PROPOSE_TOOL_NAME,
      description: PROPOSE_TOOL_DESCRIPTION,
      schema: proposeToolInputSchema,
      func: async (rawInput) => JSON.stringify(await createBackgroundTaskPreview(input, rawInput), null, 2)
    }),
    new DynamicStructuredTool<
      typeof scheduleInputSchema,
      z.infer<typeof scheduleInputSchema>,
      z.infer<typeof scheduleInputSchema>,
      string
    >({
      name: 'schedule_background_task',
      description: SCHEDULE_TOOL_DESCRIPTION,
      schema: scheduleInputSchema,
      func: async (rawInput) => JSON.stringify(await scheduleBackgroundTask(input, rawInput), null, 2)
    }),
    new DynamicStructuredTool<typeof readInputSchema, z.infer<typeof readInputSchema>, z.infer<typeof readInputSchema>, string>({
      name: 'read_background_task',
      description: '读取后台任务定义、状态和最近运行信息。',
      schema: readInputSchema,
      func: async (rawInput) => JSON.stringify(await readBackgroundTask(input, rawInput), null, 2)
    })
  ];
  const changeTools = [
    creationTools[2],
    new DynamicStructuredTool<typeof updateInputSchema, z.infer<typeof updateInputSchema>, z.infer<typeof updateInputSchema>, string>({
      name: 'update_background_task',
      description: '修改后台任务；执行前由 HITL 审批。',
      schema: updateInputSchema,
      func: async (rawInput) => JSON.stringify(await updateBackgroundTask(input, rawInput), null, 2)
    }),
    new DynamicStructuredTool<typeof cancelInputSchema, z.infer<typeof cancelInputSchema>, z.infer<typeof cancelInputSchema>, string>({
      name: 'cancel_background_task',
      description: '取消后台任务；执行前由 HITL 审批。',
      schema: cancelInputSchema,
      func: async (rawInput) => JSON.stringify(await cancelBackgroundTask(input, rawInput), null, 2)
    })
  ];
  if (input.toolMode === 'change') {
    return changeTools;
  }
  return creationTools;
}

async function createBackgroundTaskPreview(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<Record<string, unknown>> {
  const request = normalizePreviewRequest(input, rawInput);
  const preview = await input.taskAdapter.createBackgroundTaskPreview(request);
  const previewId = input.previewStore.generatePreviewId();
  input.previewStore.put(previewId, { request, preview });
  return {
    previewId,
    preview
  };
}

async function scheduleBackgroundTask(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<Record<string, unknown>> {
  const { previewId } = scheduleInputSchema.parse(rawInput);
  const stored = input.previewStore.take(previewId);
  if (stored === null) {
    throw new RocToolResolutionError(`Unknown previewId ${previewId}. 请先调用 propose_background_task 生成新的 preview。`, {
      toolName: 'schedule_background_task'
    });
  }
  const task = await input.taskAdapter.createBackgroundTask(stored.request);
  input.schedulerAdapter.registerTask(task);
  return {
    ok: true,
    taskId: task.id,
    threadId: task.threadId,
    scheduledNextRunAt: task.nextRunAt
  };
}

async function readBackgroundTask(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<Record<string, unknown>> {
  const { taskId } = readInputSchema.parse(rawInput);
  const detail = await input.taskAdapter.readBackgroundTask(taskId);
  if (detail.backgroundTask === null) {
    throw new RocToolResolutionError(`Background task ${taskId} does not exist.`, {
      toolName: 'read_background_task'
    });
  }
  return {
    ok: true,
    taskId,
    detail
  };
}

async function updateBackgroundTask(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<Record<string, unknown>> {
  const request = updateInputSchema.parse(rawInput);
  validatePatch(request.patch);
  const task = await input.taskAdapter.updateBackgroundTask(toUpdateRequest(request));
  input.schedulerAdapter.refreshTask(task);
  return {
    ok: true,
    taskId: task.id,
    threadId: task.threadId,
    scheduledNextRunAt: task.nextRunAt
  };
}

async function cancelBackgroundTask(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<Record<string, unknown>> {
  const request = cancelInputSchema.parse(rawInput);
  const task = await input.taskAdapter.cancelBackgroundTask(request.taskId);
  input.schedulerAdapter.unregisterTask(task.id);
  return {
    ok: true,
    taskId: task.id,
    threadId: task.threadId,
    status: task.status
  };
}

function normalizePreviewRequest(input: BackgroundTaskToolDependencies, rawInput: unknown): BackgroundTaskPreviewRequest {
  const parsed = proposeToolInputSchema.parse(rawInput);
  if (input.runtimeWorkspacePath === null) {
    throw new RocDomainError({
      code: 'background_task_workspace_required',
      message: '创建后台任务需要先选择工作区。',
      category: 'validation',
      retryable: true,
      userAction: '请先选择一个工作区，再创建后台任务。'
    });
  }
  const request: BackgroundTaskPreviewRequest = {
    goal: parsed.goal,
    trigger: normalizeTriggerForPreview(parsed.trigger),
    workspacePath: input.runtimeWorkspacePath,
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: input.enabledCapabilities === undefined ? null : input.enabledCapabilities
  };
  validateTrigger(request.trigger);
  validateWorkspacePath(request.workspacePath);
  return request;
}

function normalizeTriggerForPreview(trigger: z.infer<typeof modelTriggerSchema>): z.infer<typeof triggerSchema> {
  if (trigger.type === 'manual') {
    return {
      type: 'manual',
      description: readTriggerDescription(trigger.description, '手动触发')
    };
  }
  if (trigger.type === 'once') {
    return {
      type: 'once',
      description: readTriggerDescription(trigger.description, `在 ${trigger.nextRunAt} 触发`),
      nextRunAt: trigger.nextRunAt
    };
  }
  return {
    type: 'cron',
    description: readTriggerDescription(trigger.description, describeCronTrigger(trigger.cronExpression)),
    cronExpression: trigger.cronExpression,
    nextRunAt: trigger.nextRunAt
  };
}

function readTriggerDescription(value: string | undefined, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function describeCronTrigger(cronExpression: string): string {
  const fields = cronExpression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return `按 cron ${cronExpression} 触发`;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (/^\d+$/u.test(minute) && /^\d+$/u.test(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每天 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} 触发`;
  }
  if (/^\d+$/u.test(minute) && /^\d+$/u.test(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    return `每周 ${dayOfWeek} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} 触发`;
  }
  return `按 cron ${cronExpression} 触发`;
}

function toUpdateRequest(input: z.infer<typeof updateInputSchema>): UpdateBackgroundTaskRequest {
  return {
    taskId: input.taskId,
    patch: {
      ...input.patch,
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    } as Partial<BackgroundTaskPreviewRequest>,
    reason: input.reason
  };
}

function validatePatch(patch: Partial<z.infer<typeof proposeInputSchema>>): void {
  if (patch.trigger !== undefined) {
    validateTrigger(patch.trigger);
  }
  if (patch.workspacePath !== undefined) {
    validateWorkspacePath(patch.workspacePath);
  }
}

function validateTrigger(trigger: z.infer<typeof triggerSchema>): void {
  if (trigger.type === 'cron') {
    parseCronExpression(trigger.cronExpression);
  }
  if (trigger.type === 'once') {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    if (new Date(trigger.nextRunAt).getTime() < fiveMinutesAgo) {
      throw new RocDomainError({
        code: 'background_task_schedule_in_past',
        message: '一次性后台任务触发时间已过期。',
        category: 'validation',
        retryable: true,
        userAction: '请设置未来的触发时间。'
      });
    }
  }
}

function validateWorkspacePath(workspacePath: string): void {
  if (!existsSync(workspacePath)) {
    throw new RocDomainError({
      code: 'background_task_workspace_unreachable',
      message: '后台任务工作区路径不可访问。',
      category: 'validation',
      retryable: true,
      userAction: '请选择仍然存在的工作区路径。'
    });
  }
}
