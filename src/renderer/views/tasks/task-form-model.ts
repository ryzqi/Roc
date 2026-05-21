import type { BackgroundTaskPreviewRequest, BackgroundTaskTrigger, ChatResumeDecision, ChatPendingApproval } from '../../../shared/types';

export type TaskTriggerMode = BackgroundTaskTrigger['type'];

export type TaskFormDraft = {
  goal: string;
  triggerType: TaskTriggerMode;
  triggerDescription: string;
  nextRunAt: string;
  cronExpression: string;
  workspacePath: string;
  allowedActionsText: string;
  forbiddenActionsText: string;
  reason: string;
};

export function createTaskFormDraft(
  base?: Partial<BackgroundTaskPreviewRequest> & {
    reason?: string;
  }
): TaskFormDraft {
  const trigger = base?.trigger;
  const nextRunAt =
    trigger === undefined || trigger.type === 'manual' ? '' : isoToLocalInputValue(trigger.nextRunAt);
  const cronExpression = trigger !== undefined && trigger.type === 'cron' ? trigger.cronExpression : '';
  return {
    goal: base?.goal ?? '',
    triggerType: trigger?.type ?? 'manual',
    triggerDescription: trigger?.description ?? '',
    nextRunAt,
    cronExpression,
    workspacePath: base?.workspacePath ?? '',
    allowedActionsText: joinActions(base?.allowedActions ?? []),
    forbiddenActionsText: joinActions(base?.forbiddenActions ?? []),
    reason: base?.reason ?? ''
  };
}

export function buildBackgroundTaskPreviewRequest(draft: TaskFormDraft): BackgroundTaskPreviewRequest {
  return {
    goal: draft.goal.trim(),
    trigger: buildTrigger(draft),
    workspacePath: draft.workspacePath.trim(),
    allowedActions: splitActions(draft.allowedActionsText),
    forbiddenActions: splitActions(draft.forbiddenActionsText),
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations'
  };
}

export function buildTaskApprovalEditDecision(input: {
  approval: ChatPendingApproval;
  draft: TaskFormDraft;
}): ChatResumeDecision {
  const action = input.approval.actionRequests[0];
  if (action === undefined) {
    return {
      type: 'reject'
    };
  }

  if (action.name === 'cancel_background_task') {
    return {
      type: 'edit',
      editedAction: {
        name: action.name,
        args: {
          taskId: readTaskId(action.args),
          reason: input.draft.reason.trim()
        }
      }
    };
  }

  if (action.name === 'update_background_task') {
    return {
      type: 'edit',
      editedAction: {
        name: action.name,
        args: {
          taskId: readTaskId(action.args),
          patch: buildBackgroundTaskPreviewRequest(input.draft),
          reason: input.draft.reason.trim()
        }
      }
    };
  }

  return {
    type: 'edit',
    editedAction: {
      name: action.name,
      args: buildBackgroundTaskPreviewRequest(input.draft)
    }
  };
}

function buildTrigger(draft: TaskFormDraft): BackgroundTaskTrigger {
  if (draft.triggerType === 'manual') {
    return {
      type: 'manual',
      description: draft.triggerDescription.trim()
    };
  }
  if (draft.triggerType === 'once') {
    return {
      type: 'once',
      description: draft.triggerDescription.trim(),
      nextRunAt: localInputValueToIso(draft.nextRunAt)
    };
  }
  return {
    type: 'cron',
    description: draft.triggerDescription.trim(),
    cronExpression: draft.cronExpression.trim(),
    nextRunAt: localInputValueToIso(draft.nextRunAt)
  };
}

function splitActions(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function joinActions(values: string[]): string {
  return values.join('\n');
}

function readTaskId(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const taskId = Reflect.get(value, 'taskId');
  return typeof taskId === 'string' ? taskId : '';
}

function isoToLocalInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function localInputValueToIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString();
}
