import { existsSync } from 'node:fs';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatResumeDecision,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import { RocDomainError } from '../errors';
import type { TaskSchedulerService } from '../task-scheduler-service';
import type { TaskService } from '../task-service';
import { parseCronExpression } from '../task/cron-parser';

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

export const proposeInputSchema = z.object({
  goal: z.string().min(1).max(500).describe('后台任务目标，单句中文描述。'),
  trigger: triggerSchema,
  workspacePath: z.string().min(1).describe('Windows 绝对工作区路径，由 runtime 注入。'),
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

type BackgroundTaskToolDependencies = {
  taskService: TaskService;
  schedulerService: TaskSchedulerService;
};

export function createBackgroundTaskTools(input: BackgroundTaskToolDependencies): [
  DynamicStructuredTool<any, any, any, string>,
  DynamicStructuredTool<any, any, any, string>,
  DynamicStructuredTool<any, any, any, string>
] {
  return [
    new DynamicStructuredTool<typeof proposeInputSchema, z.infer<typeof proposeInputSchema>, z.infer<typeof proposeInputSchema>, string>({
      name: 'propose_background_task',
      description: '直接创建后台或定时任务。可选字段 enabledCapabilities：仅当用户明确要求限定 MCP 或技能时填写，否则不传，运行时将自动跟随当前全局启用集合。',
      schema: proposeInputSchema,
      func: async (rawInput) => JSON.stringify(createBackgroundTask(input, rawInput), null, 2)
    }),
    new DynamicStructuredTool<typeof updateInputSchema, z.infer<typeof updateInputSchema>, z.infer<typeof updateInputSchema>, string>({
      name: 'update_background_task',
      description: '提议修改已有后台任务。只返回审批预览，用户批准前不会修改任务。',
      schema: updateInputSchema,
      func: async (rawInput) => JSON.stringify(createUpdatePayload(input.taskService, rawInput), null, 2)
    }),
    new DynamicStructuredTool<typeof cancelInputSchema, z.infer<typeof cancelInputSchema>, z.infer<typeof cancelInputSchema>, string>({
      name: 'cancel_background_task',
      description: '提议取消已有后台任务。只返回审批请求，用户批准前不会取消任务。',
      schema: cancelInputSchema,
      func: async (rawInput) =>
        JSON.stringify(
          {
            kind: 'cancel_background_task',
            request: cancelInputSchema.parse(rawInput),
            risk: 'high',
            requiredFields: ['decision']
          },
          null,
          2
        )
    })
  ];
}

export function applyBackgroundTaskToolDecision(input: {
  taskService: TaskService;
  schedulerService: TaskSchedulerService;
  actionName: 'update_background_task' | 'cancel_background_task';
  actionArgs: unknown;
  decision: ChatResumeDecision;
}): Record<string, unknown> {
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
    const task = input.taskService.updateBackgroundTask(toUpdateRequest(request));
    input.schedulerService.refreshTask(task);
    return {
      ok: true,
      taskId: task.id,
      threadId: task.threadId,
      scheduledNextRunAt: task.nextRunAt
    };
  }

  const request = cancelInputSchema.parse(actionArgs);
  const task = input.taskService.cancelBackgroundTask(request.taskId);
  input.schedulerService.unregisterTask(task.id);
  return {
    ok: true,
    taskId: task.id,
    threadId: task.threadId,
    status: task.status
  };
}

function createBackgroundTask(input: BackgroundTaskToolDependencies, rawInput: unknown): Record<string, unknown> {
  const preview = {
    ...normalizePreview(input.taskService, rawInput),
    requiresConfirmation: false
  };
  const task = input.taskService.createBackgroundTask(preview);
  input.schedulerService.registerTask(task);
  return {
    ok: true,
    taskId: task.id,
    threadId: task.threadId,
    scheduledNextRunAt: task.nextRunAt
  };
}

function createUpdatePayload(taskService: TaskService, rawInput: unknown): Record<string, unknown> {
  const parsed = updateInputSchema.parse(rawInput);
  validatePatch(parsed.patch);
  return {
    kind: 'update_background_task',
    request: parsed,
    risk: 'high',
    requiredFields: ['decision']
  };
}

function normalizePreview(taskService: TaskService, rawInput: unknown): BackgroundTaskPreview {
  const parsed = proposeInputSchema.parse(rawInput);
  validateTrigger(parsed.trigger);
  validateWorkspacePath(parsed.workspacePath);
  return taskService.createBackgroundTaskPreview({
    goal: parsed.goal,
    trigger: parsed.trigger,
    workspacePath: parsed.workspacePath,
    allowedActions: parsed.allowedActions,
    forbiddenActions: parsed.forbiddenActions,
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: parsed.enabledCapabilities ?? null
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
