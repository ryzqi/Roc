import type { EnabledCapabilities } from './agent';

export type TaskStatus =
  | 'draft'
  | 'pending_confirmation'
  | 'running'
  | 'paused'
  | 'waiting_user'
  | 'waiting_next_turn'
  | 'failed'
  | 'cancelled'
  | 'completed'
  | 'archived';

export type TaskKind = 'chat' | 'background';

export type TaskThread = {
  id: string;
  kind: TaskKind;
  title: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type TaskEvent = {
  id: string;
  threadId: string;
  runId: string;
  type:
    | 'message'
    | 'assistant_block'
    | 'agent_update'
    | 'plan'
    | 'tool_call'
    | 'mcp_call'
    | 'skill_loaded'
    | 'subagent_event'
    | 'hook_started'
    | 'hook_completed'
    | 'agent_execute'
    | 'file_change'
    | 'git_operation'
    | 'memory_operation'
    | 'approval_requested'
    | 'approval_decision'
    | 'human_question_requested'
    | 'human_question_answered'
    | 'recovery_point'
    | 'context_manifest'
    | 'background_task_created'
    | 'background_task_paused'
    | 'background_task_resumed'
    | 'background_task_cancelled'
    | 'long_running_promoted'
    | 'guardrail_nudge'
    | 'diagnostic'
    | 'verification'
    | 'error'
    | 'summary';
  payload: unknown;
  createdAt: string;
  sequence?: number;
};

export type GuardrailNudgePayload = {
  nudgeKind: 'retry' | 'unknown_tool' | 'tool_resolution' | 'context_warning';
  tier?: number;
  content: string;
  toolCallId?: string;
  toolName?: string;
};

export type TaskSnapshot = {
  generatedAt: string;
  counts: {
    total: number;
    running: number;
    failed: number;
    pendingConfirmation: number;
  };
  threads: TaskThread[];
  recentEvents: TaskEvent[];
};

export type TaskMessageHistoryRequest = {
  threadId: string;
};

export type TaskRun = {
  id: string;
  threadId: string;
  runNumber: number;
  userInput: string;
  status: TaskStatus;
  startedAt: string;
  endedAt: string | null;
  modelId: string | null;
  enabledCapabilities: EnabledCapabilities;
};

export type TaskDeleteThreadRequest = {
  threadId: string;
};

export type TaskDeleteThreadResult = {
  deleted: true;
  threadId: string;
};

export type BackgroundTaskTrigger =
  | {
      type: 'manual';
      description: string;
    }
  | {
      type: 'once';
      description: string;
      nextRunAt: string;
    }
  | {
      type: 'cron';
      description: string;
      cronExpression: string;
      nextRunAt: string;
    };

export type BackgroundTaskRisk = 'low' | 'medium' | 'high';

export type BackgroundTaskPreviewRequest = {
  goal: string;
  trigger: BackgroundTaskTrigger;
  workspacePath: string;
  allowedActions: string[];
  forbiddenActions: string[];
  failurePolicy: 'pause_and_report';
  notificationPolicy: 'failures_and_confirmations';
  enabledCapabilities?: EnabledCapabilities | null;
};

export type BackgroundTaskPreview = BackgroundTaskPreviewRequest & {
  scheduled: boolean;
  nextRunAt: string | null;
  cronExpression: string | null;
  riskLevel: BackgroundTaskRisk;
  requiresConfirmation: boolean;
  enabledCapabilities: EnabledCapabilities | null;
};

export type BackgroundTask = {
  id: string;
  threadId: string;
  runId: string;
  goal: string;
  status: TaskStatus;
  scheduled: boolean;
  triggerType: BackgroundTaskTrigger['type'];
  triggerDescription: string;
  nextRunAt: string | null;
  cronExpression: string | null;
  workspacePath: string;
  allowedActions: string[];
  forbiddenActions: string[];
  failurePolicy: 'pause_and_report';
  notificationPolicy: 'failures_and_confirmations';
  riskLevel: BackgroundTaskRisk;
  requiresConfirmation: boolean;
  lastRunAt: string | null;
  lastRunStatus: 'success' | 'failed' | 'cancelled' | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  enabledCapabilities: EnabledCapabilities | null;
};

export type ActiveTaskItem = {
  kind: 'background';
  threadId: string;
  taskId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  trigger: BackgroundTaskTrigger | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  riskLevel: BackgroundTaskRisk;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledTaskRun = {
  id: string;
  backgroundTaskId: string;
  taskRunId: string | null;
  scheduledAt: string;
  triggeredAt: string | null;
  status: 'pending' | 'fired' | 'skipped' | 'failed';
  skipReason: string | null;
};

export type TaskDetail = {
  threadId: string;
  taskId: string | null;
  thread: TaskThread;
  backgroundTask: BackgroundTask | null;
  lastRunId: string | null;
  runHistory: TaskRun[];
  recentEvents: TaskEvent[];
  schedulerRegistered: boolean;
};

export type UpdateBackgroundTaskRequest = {
  taskId: string;
  patch: Partial<BackgroundTaskPreviewRequest>;
  reason: string;
};

export type TaskUpdateEvent =
  | { kind: 'task_created'; taskId: string }
  | { kind: 'task_status_changed'; taskId: string; status: TaskStatus }
  | { kind: 'task_run_fired'; taskId: string; runId: string }
  | { kind: 'thread_deletion_started'; threadId: string }
  | { kind: 'scheduler_health_changed'; healthy: boolean };

export type SchedulerStatus = {
  running: boolean;
  registeredTaskCount: number;
  nextFireAt: string | null;
  recentSkippedCount: number;
  lastError: string | null;
};

export type BackgroundTaskSummary = {
  total: number;
  running: number;
  failed: number;
  pendingConfirmation: number;
  nextRunAt: string | null;
};

export type TraySummary = {
  residentEnabled: boolean;
  backgroundPaused: boolean;
  backgroundTasks: BackgroundTaskSummary;
  nextRunAt: string | null;
  updatedAt: string;
};
