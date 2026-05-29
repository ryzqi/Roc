import type { EnabledCapabilities } from './agent';
import type { HITLRequest, HITLResponse } from 'langchain';

export type ChatRunMode = 'chat' | 'task';

export type WorkflowHint = 'propose_background_task' | 'background_task_change' | null;

export type ChatTodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type ChatToolEventStatus = 'start' | 'progress' | 'end' | 'error';

export type ChatApprovalRequest = HITLRequest;

export type ChatPendingApproval = HITLRequest & {
  interruptId: string;
};

export type ChatResumeDecision = HITLResponse['decisions'][number];

export type ChatResumeRunRequest = {
  runId: string;
  threadId: string;
  interruptId?: string;
  decisions: ChatResumeDecision[];
};

export type ChatResumeRunResult = {
  runId: string;
  threadId: string;
  resumedAt: string;
};

export type ChatRunEvent =
  | {
      type: 'run_started';
      runId: string;
      mode: ChatRunMode;
      threadId: string | null;
      providerId: string;
      modelId: string;
      createdAt: string;
    }
  | {
      type: 'message_delta';
      runId: string;
      delta: string;
    }
  | {
      type: 'reasoning_delta';
      runId: string;
      delta: string;
    }
  | {
      type: 'run_interrupted';
      runId: string;
      threadId: string | null;
      interruptId: string;
      payload: ChatApprovalRequest;
    }
  | {
      type: 'run_resumed';
      runId: string;
      threadId: string | null;
      interruptId: string;
    }
  | {
      type: 'tool_event';
      runId: string;
      event: ChatToolEventStatus;
      name: string;
      data: unknown;
    }
  | {
      type: 'todo_event';
      runId: string;
      todos: ChatTodoItem[];
    }
  | {
      type: 'subagent_event';
      runId: string;
      subagent: string;
      status: 'started' | 'completed' | 'failed';
      summary: string | null;
    }
  | {
      type: 'run_completed';
      runId: string;
      threadId: string | null;
      providerId: string;
      modelId: string;
      createdAt: string;
      durationMs: number;
      summary: string;
      assistantMessage: string;
    }
  | {
      type: 'run_failed';
      runId: string;
      threadId: string | null;
      code: string;
      diagnostic?: {
        badKeys?: string[];
        schemaPath?: string;
        toolName?: string;
      };
      message: string;
      retryable: boolean;
      suggestion?: string;
    };

export type ChatStartRunRequest = {
  input: string;
  mode: ChatRunMode;
  enabledCapabilities: EnabledCapabilities;
  threadId?: string | null;
  workflowHint?: WorkflowHint;
};

export type ChatStartRunResult = {
  runId: string;
  mode: ChatRunMode;
  threadId: string | null;
  providerId: string;
  modelId: string;
  createdAt: string;
};

export type ChatCancelRunResult = {
  runId: string;
  cancelled: boolean;
};
