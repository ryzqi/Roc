import type { EnabledCapabilities } from './agent';

export type ChatRunMode = 'chat' | 'task';

export type ChatTodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type ChatToolEventStatus = 'start' | 'progress' | 'end' | 'error';

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
      message: string;
      retryable: boolean;
    };

export type ChatStartRunRequest = {
  input: string;
  mode: ChatRunMode;
  enabledCapabilities: EnabledCapabilities;
  threadId?: string | null;
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
