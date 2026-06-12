import { existsSync } from 'node:fs';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatResumeDecision,
  EnabledCapabilities,
  TaskDetail,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import { PROPOSE_TOOL_DESCRIPTION, PROPOSE_TOOL_NAME } from '../../../shared/background-task-tool-contract';
import { RocDomainError } from '../errors';
import { PreviewStore, RocToolResolutionError } from '../forge-guardrails';
import { parseCronExpression } from '../../plugins/task/cron-parser';

export const manualTriggerSchema = z.strictObject({
  type: z.literal('manual').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).describe('展示给用户的触发说明，单句中文。')
});

export const onceTriggerSchema = z.strictObject({
  type: z.literal('once').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).describe('展示给用户的触发说明，单句中文。'),
  nextRunAt: z.string().datetime().describe('UTC ISO 时间戳（含 T 与 Z），调度器下次触发时间。')
});

export const cronTriggerSchema = z.strictObject({
  type: z.literal('cron').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).describe('展示给用户的触发说明，单句中文。'),
  cronExpression: z.string().min(1).describe('五段 cron，按本机时区执行，例如 50 21 * * *。'),
  nextRunAt: z.string().datetime().describe('UTC ISO 时间戳（含 T 与 Z），调度器下次触发时间。')
});

export const triggerSchema = z
  .discriminatedUnion('type', [manualTriggerSchema, onceTriggerSchema, cronTriggerSchema])
  .describe('触发类型：manual / once / cron。');

export const enabledCapabilitiesSchema = z.object({
  mcpServers: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([])
});

export const proposeToolInputSchema = z.strictObject({
  goal: z.string().min(1).max(500).describe('后台任务目标，单句中文描述。'),
  trigger: triggerSchema,
  workspacePath: z.string().min(1).describe('Windows 绝对工作区路径，由 runtime 注入。')
});

export const proposeInputSchema = proposeToolInputSchema.extend({
  allowedActions: z.array(z.string()).default([]).describe('动作边界字符串数组，可为空。'),
  forbiddenActions: z.array(z.string()).default([]).describe('动作边界字符串数组，可为空。'),
  notificationPolicy: z.literal('failures_and_confirmations').default('failures_and_confirmations'),
  enabledCapabilities: enabledCapabilitiesSchema.nullable().optional()
});

export const updateInputSchema = z.object({
  taskId: z.string().min(1),
  patch: proposeInputSchema.partial(),
  reason: z.string().min(1)
});

export const cancelInputSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1)
});

export const readInputSchema = z.strictObject({
  taskId: z.string().min(1)
});

export const scheduleInputSchema = z.strictObject({
  previewId: z.string().min(1).describe('propose_background_task 返回的 previewId。')
});

export const SCHEDULE_TOOL_DESCRIPTION = [
  '把 propose_background_task 返回的 preview 实际落地为后台任务并加入调度。',
  '必须先调用过 propose_background_task 拿到 previewId。',
  '本工具会创建任务、注册调度器，并返回真实 taskId。'
].join('\n');

type BackgroundTaskToolDependencies = {
  taskAdapter: BackgroundTaskToolTaskAdapter;
  schedulerAdapter: BackgroundTaskToolSchedulerAdapter;
  enabledCapabilities?: EnabledCapabilities;
  previewStore: PreviewStore;
};

type Awaitable<T> = T | Promise<T>;

type BackgroundTaskToolTaskAdapter = {
  createBackgroundTask(preview: BackgroundTaskPreview): Awaitable<{ id: string; threadId: string; nextRunAt: string | null; status?: string }>;
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

export function createBackgroundTaskTools(input: BackgroundTaskToolDependencies): Array<DynamicStructuredTool<any, any, any, string>> {
  return [
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
      description: '读取已有后台任务定义、状态和最近运行信息。',
      schema: readInputSchema,
      func: async (rawInput) => JSON.stringify(await readBackgroundTask(input, rawInput), null, 2)
    }),
    new DynamicStructuredTool<typeof updateInputSchema, z.infer<typeof updateInputSchema>, z.infer<typeof updateInputSchema>, string>({
      name: 'update_background_task',
      description: '修改已有后台任务；本工具由 HITL 在执行前审批，审批通过或编辑后才会执行。',
      schema: updateInputSchema,
      func: async (rawInput) => JSON.stringify(await updateBackgroundTask(input, rawInput), null, 2)
    }),
    new DynamicStructuredTool<typeof cancelInputSchema, z.infer<typeof cancelInputSchema>, z.infer<typeof cancelInputSchema>, string>({
      name: 'cancel_background_task',
      description: '取消已有后台任务；本工具由 HITL 在执行前审批，审批通过或编辑后才会执行。',
      schema: cancelInputSchema,
      func: async (rawInput) => JSON.stringify(await cancelBackgroundTask(input, rawInput), null, 2)
    })
  ];
}

export async function applyBackgroundTaskToolDecision(input: {
  taskAdapter: BackgroundTaskToolTaskAdapter;
  schedulerAdapter: BackgroundTaskToolSchedulerAdapter;
  actionName: 'update_background_task' | 'cancel_background_task';
  actionArgs: unknown;
  decision: ChatResumeDecision;
}): Promise<Record<string, unknown>> {
  if (input.decision.type === 'reject') {
    return {
      ok: false,
      reason: 'rejected'
    };
  }

  const actionArgs = readApprovedActionArgs(input.actionName, input.actionArgs, input.decision);
  if (input.actionName === 'update_background_task') {
    const request = updateInputSchema.parse(actionArgs);
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

  const request = cancelInputSchema.parse(actionArgs);
  const task = await input.taskAdapter.cancelBackgroundTask(request.taskId);
  input.schedulerAdapter.unregisterTask(task.id);
  return {
    ok: true,
    taskId: task.id,
    threadId: task.threadId,
    status: task.status
  };
}

async function createBackgroundTaskPreview(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<Record<string, unknown>> {
  const preview = {
    ...(await normalizePreview(input, rawInput)),
    requiresConfirmation: false
  };
  const previewId = input.previewStore.generatePreviewId();
  input.previewStore.put(previewId, preview);
  return {
    previewId,
    preview
  };
}

async function scheduleBackgroundTask(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<Record<string, unknown>> {
  const { previewId } = scheduleInputSchema.parse(rawInput);
  const preview = input.previewStore.take(previewId);
  if (preview === null) {
    throw new RocToolResolutionError(`Unknown previewId ${previewId}. 请先调用 propose_background_task 生成新的 preview。`, {
      toolName: 'schedule_background_task'
    });
  }
  const task = await input.taskAdapter.createBackgroundTask(preview);
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

async function normalizePreview(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<BackgroundTaskPreview> {
  const parsed = proposeToolInputSchema.parse(rawInput);
  validateTrigger(parsed.trigger);
  validateWorkspacePath(parsed.workspacePath);
  return await input.taskAdapter.createBackgroundTaskPreview({
    goal: parsed.goal,
    trigger: parsed.trigger,
    workspacePath: parsed.workspacePath,
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: input.enabledCapabilities === undefined ? null : input.enabledCapabilities
  });
}

function readApprovedActionArgs(
  actionName: string,
  originalArgs: unknown,
  decision: ChatResumeDecision
): unknown {
  if (decision.type === 'approve') {
    return originalArgs;
  }
  if (decision.type !== 'edit') {
    return originalArgs;
  }

  const editedAction = Reflect.get(decision, 'editedAction');
  if (typeof editedAction !== 'object' || editedAction === null || Reflect.get(editedAction, 'name') !== actionName) {
    throw new RocDomainError({
      code: 'background_task_edited_action_mismatch',
      message: '后台任务审批编辑内容与原工具不匹配。',
      category: 'validation',
      retryable: false,
      userAction: '请只编辑当前审批卡中的后台任务字段。'
    });
  }
  return Reflect.get(editedAction, 'args');
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

export function validateBackgroundTaskPatch(patch: Partial<z.infer<typeof proposeInputSchema>>): void {
  validatePatch(patch);
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

export function validateBackgroundTaskTrigger(trigger: z.infer<typeof triggerSchema>): void {
  validateTrigger(trigger);
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

export function validateBackgroundTaskWorkspacePath(workspacePath: string): void {
  validateWorkspacePath(workspacePath);
}
