import type {
  ActiveTaskItem,
  AgentCapabilityManifest,
  AgentCapabilityPreview,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskTrigger,
  EnabledCapabilities,
  ScheduledTaskRun,
  TaskEvent,
  TaskRun,
  TaskStatus,
  TaskThread
} from '../../../shared/types';
export type BackgroundTaskRecord = {
  id: string;
  thread_id: string;
  run_id: string;
  goal: string;
  status: TaskStatus;
  scheduled: 0 | 1;
  trigger_type: BackgroundTaskTrigger['type'];
  trigger_description: string;
  next_run_at: string | null;
  cron_expression: string | null;
  workspace_path: string;
  allowed_actions_json: string;
  forbidden_actions_json: string;
  failure_policy: BackgroundTask['failurePolicy'];
  notification_policy: BackgroundTask['notificationPolicy'];
  risk_level: BackgroundTask['riskLevel'];
  requires_confirmation: 0 | 1;
  last_run_at: string | null;
  last_run_status: BackgroundTask['lastRunStatus'];
  run_count: number;
  created_at: string;
  updated_at: string;
  enabled_capabilities_json: string | null;
};

export type TaskEventRow = {
  id: string;
  thread_id: string;
  run_id: string;
  type: TaskEvent['type'];
  payload_json: string;
  created_at: string;
};

export type TaskThreadRow = {
  id: string;
  kind: ActiveTaskItem['kind'];
  title: string;
  goal: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
};

export type ScheduledTaskRunRow = {
  id: string;
  background_task_id: string;
  task_run_id: string | null;
  scheduled_at: string;
  triggered_at: string | null;
  status: ScheduledTaskRun['status'];
  skip_reason: string | null;
};

export type TaskRunRow = {
  id: string;
  thread_id: string;
  run_number: number;
  user_input: string;
  status: TaskRun['status'];
  started_at: string;
  ended_at: string | null;
  model_id: string | null;
  enabled_capabilities_json: string;
};

export function mapBackgroundTask(row: BackgroundTaskRecord): BackgroundTask {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    goal: row.goal,
    status: row.status,
    scheduled: row.scheduled === 1,
    triggerType: row.trigger_type,
    triggerDescription: row.trigger_description,
    nextRunAt: row.next_run_at,
    cronExpression: row.cron_expression,
    workspacePath: row.workspace_path,
    allowedActions: JSON.parse(row.allowed_actions_json) as string[],
    forbiddenActions: JSON.parse(row.forbidden_actions_json) as string[],
    failurePolicy: row.failure_policy,
    notificationPolicy: row.notification_policy,
    riskLevel: row.risk_level,
    requiresConfirmation: row.requires_confirmation === 1,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabledCapabilities: parseEnabledCapabilities(row.enabled_capabilities_json)
  };
}

export function mapScheduledTaskRun(row: ScheduledTaskRunRow): ScheduledTaskRun {
  return {
    id: row.id,
    backgroundTaskId: row.background_task_id,
    taskRunId: row.task_run_id,
    scheduledAt: row.scheduled_at,
    triggeredAt: row.triggered_at,
    status: row.status,
    skipReason: row.skip_reason
  };
}

export function mapTaskEvent(row: TaskEventRow & { rowid?: number }): TaskEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
    sequence: row.rowid
  };
}

export function mapTaskRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    threadId: row.thread_id,
    runNumber: row.run_number,
    userInput: row.user_input,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    modelId: row.model_id,
    enabledCapabilities: JSON.parse(row.enabled_capabilities_json) as EnabledCapabilities
  };
}

export function mapTaskThread(row: TaskThreadRow): TaskThread {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    goal: row.goal,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mergeTaskEvents(eventGroups: readonly TaskEvent[][]): TaskEvent[] {
  const eventsById = new Map<string, TaskEvent>();
  for (const events of eventGroups) {
    for (const event of events) {
      if (!eventsById.has(event.id)) {
        eventsById.set(event.id, event);
      }
    }
  }
  return [...eventsById.values()].sort(compareTaskEventsDescending);
}

export function createFallbackCapabilityManifest(enabledCapabilities: EnabledCapabilities): AgentCapabilityManifest {
  return {
    requestedCapabilities: enabledCapabilities,
    resolvedCapabilities: enabledCapabilities,
    skippedCapabilities: [],
    toolCards: [],
    untrustedContextPolicy: 'external_content_reference_only'
  };
}

export function createAgentCapabilityManifest(preview: AgentCapabilityPreview): AgentCapabilityManifest {
  return {
    requestedCapabilities: preview.requestedCapabilities,
    resolvedCapabilities: preview.selectedCapabilities,
    skippedCapabilities: preview.skippedCapabilities,
    toolCards: [...preview.toolCards, ...preview.skillCards].map((card) => ({
      id: card.id,
      name: card.name,
      capabilityType: card.capabilityType,
      riskLevel: card.riskLevel,
      scope: card.scope,
      requiresApproval: card.requiresApproval
    })),
    untrustedContextPolicy: preview.untrustedContextPolicy
  };
}

function compareTaskEventsDescending(left: TaskEvent, right: TaskEvent): number {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  return (right.sequence === undefined ? 0 : right.sequence) - (left.sequence === undefined ? 0 : left.sequence);
}

function parseEnabledCapabilities(value: string | null): EnabledCapabilities | null {
  if (value === null) {
    return null;
  }
  return JSON.parse(value) as EnabledCapabilities;
}

export function normalizeTrigger(trigger: BackgroundTaskTrigger, description: string): BackgroundTaskTrigger {
  if (trigger.type === 'manual') {
    return { type: 'manual', description };
  }
  if (trigger.type === 'once') {
    return { type: 'once', description, nextRunAt: trigger.nextRunAt };
  }
  return {
    type: 'cron',
    description,
    cronExpression: trigger.cronExpression,
    nextRunAt: trigger.nextRunAt
  };
}

export function taskTrigger(task: BackgroundTask): BackgroundTaskTrigger {
  if (task.triggerType === 'manual') {
    return {
      type: 'manual',
      description: task.triggerDescription
    };
  }
  if (task.triggerType === 'once') {
    if (task.nextRunAt === null) {
      throw new Error('background_task_next_run_missing');
    }
    return {
      type: 'once',
      description: task.triggerDescription,
      nextRunAt: task.nextRunAt
    };
  }
  if (task.nextRunAt === null || task.cronExpression === null) {
    throw new Error('background_task_cron_missing');
  }
  return {
    type: 'cron',
    description: task.triggerDescription,
    cronExpression: task.cronExpression,
    nextRunAt: task.nextRunAt
  };
}

export function requireText(value: string, code: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(code);
  }
  return trimmed;
}

export function inferBackgroundRisk(allowedActions: string[], forbiddenActions: string[]): BackgroundTaskPreview['riskLevel'] {
  const commands = [...allowedActions, ...forbiddenActions].map((item) => item.toLowerCase());
  if (commands.some((command) => command.includes('git push') || command.includes('rm ') || command.includes('remove-item'))) {
    return 'medium';
  }
  if (commands.length === 0) {
    return 'low';
  }
  return 'medium';
}
