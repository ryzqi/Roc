import { randomUUID } from 'node:crypto';

import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  EnabledCapabilities,
  TaskEvent,
  Workspace
} from '../../../shared/types';
import type { RocPluginContext } from '../../kernel/types';
import { resolveBackgroundTaskTime } from '../../services/deep-agent/background-task-time-tool';

export type TaskProposalWorkflowInput = {
  runId: string;
  threadId: string;
  input: string;
  enabledCapabilities: EnabledCapabilities;
  recordTaskEvent: (type: TaskEvent['type'], payload: Record<string, unknown>) => Promise<void>;
};

export type TaskProposalWorkflowResult = {
  assistantMessage: string;
  summary: string;
};

export type TaskProposalWorkflow = (input: TaskProposalWorkflowInput) => Promise<TaskProposalWorkflowResult>;

type CapabilityInvoker = {
  invoke<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
};

export function createTaskProposalWorkflow(context: RocPluginContext): TaskProposalWorkflow {
  return async (input) =>
    runTaskProposalWorkflow({
      capabilities: context.capabilities,
      input
    });
}

export function normalizeBackgroundTaskProposalGoal(description: string): string {
  const trimmed = requireNonEmptyText(description, 'background_task_description_empty');
  const withoutCurrentWorkspaceSuffix = trimmed.replace(/[，,]\s*使用当前工作区[。.]?$/u, '').trim();
  if (withoutCurrentWorkspaceSuffix.length === 0) {
    return trimmed;
  }
  return withoutCurrentWorkspaceSuffix;
}

async function runTaskProposalWorkflow(input: {
  capabilities: CapabilityInvoker;
  input: TaskProposalWorkflowInput;
}): Promise<TaskProposalWorkflowResult> {
  const description = requireNonEmptyText(input.input.input, 'background_task_description_empty');
  const workspace = await input.capabilities.invoke<{}, Workspace | null>('workspace.getCurrent', {});
  if (workspace === null) {
    throw new Error('background_task_workspace_missing');
  }

  const timeResult = await recordTool(input.input, 'resolve_background_task_time', { text: description }, async () =>
    resolveBackgroundTaskTime({ text: description })
  );
  if (timeResult.status !== 'resolved') {
    const summary = timeResult.clarificationQuestion;
    return {
      assistantMessage: summary,
      summary
    };
  }

  const previewRequest: BackgroundTaskPreviewRequest = {
    goal: normalizeBackgroundTaskProposalGoal(description),
    trigger: timeResult.trigger,
    workspacePath: workspace.path,
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: input.input.enabledCapabilities
  };
  const previewId = `preview_${randomUUID()}`;
  const preview = await recordTool(input.input, 'propose_background_task', previewRequest, async () => {
    const createdPreview = await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTaskPreview>(
      'task.background.preview',
      previewRequest
    );
    return {
      previewId,
      preview: createdPreview
    };
  });
  const task = await recordTool(input.input, 'schedule_background_task', { previewId }, async () => {
    const createdTask = await input.capabilities.invoke<BackgroundTaskPreview, BackgroundTask>(
      'task.background.create',
      preview.preview
    );
    return {
      ok: true,
      taskId: createdTask.id,
      threadId: createdTask.threadId,
      scheduledNextRunAt: createdTask.nextRunAt,
      task: createdTask
    };
  });
  const summary = `后台任务已创建：${task.task.goal}`;
  return {
    assistantMessage: summary,
    summary
  };
}

async function recordTool<TOutput>(
  input: TaskProposalWorkflowInput,
  name: string,
  toolInput: Record<string, unknown>,
  operation: () => Promise<TOutput> | TOutput
): Promise<TOutput> {
  await input.recordTaskEvent('tool_call', {
    name,
    status: 'start',
    input: toolInput
  });
  try {
    const output = await operation();
    await input.recordTaskEvent('tool_call', {
      name,
      status: 'end',
      output
    });
    return output;
  } catch (error) {
    await input.recordTaskEvent('tool_call', {
      name,
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function requireNonEmptyText(value: string, code: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(code);
  }
  return trimmed;
}
