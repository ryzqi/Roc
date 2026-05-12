import type { EnabledCapabilities } from './agent';
import type { ShellCommandRisk } from './rtk';

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

export type TaskThread = {
  id: string;
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
    | 'message_delta'
    | 'agent_update'
    | 'plan'
    | 'tool_call'
    | 'mcp_call'
    | 'skill_loaded'
    | 'subagent_started'
    | 'subagent_completed'
    | 'terminal_command'
    | 'file_change'
    | 'git_operation'
    | 'memory_operation'
    | 'approval_requested'
    | 'approval_decision'
    | 'recovery_point'
    | 'context_manifest'
    | 'background_task_created'
    | 'background_task_paused'
    | 'background_task_resumed'
    | 'background_task_cancelled'
    | 'diagnostic'
    | 'verification'
    | 'error'
    | 'summary';
  payload: unknown;
  createdAt: string;
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

export type BackgroundTaskTrigger = {
  type: 'manual' | 'schedule';
  description: string;
  nextRunAt: string | null;
};

export type BackgroundTaskPreviewRequest = {
  goal: string;
  trigger: BackgroundTaskTrigger;
  workspacePath: string;
  allowedActions: string[];
  forbiddenActions: string[];
  failurePolicy: 'pause_and_report';
  notificationPolicy: 'failures_and_confirmations';
};

export type BackgroundTaskPreview = BackgroundTaskPreviewRequest & {
  scheduled: boolean;
  nextRunAt: string | null;
  riskLevel: ShellCommandRisk;
  requiresConfirmation: boolean;
};

export type BackgroundTask = {
  id: string;
  threadId: string;
  runId: string;
  goal: string;
  status: TaskStatus;
  scheduled: boolean;
  triggerDescription: string;
  nextRunAt: string | null;
  workspacePath: string;
  allowedActions: string[];
  forbiddenActions: string[];
  failurePolicy: 'pause_and_report';
  notificationPolicy: 'failures_and_confirmations';
  riskLevel: ShellCommandRisk;
  requiresConfirmation: boolean;
  createdAt: string;
  updatedAt: string;
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
