import type { AsyncTaskStatus } from 'deepagents';
import type { HITLRequest, HITLResponse } from 'langchain';
import type { EnabledCapabilities } from './agent';

export type ChatRunMode = 'chat' | 'task';

export type WorkflowHint = 'propose_background_task' | 'background_task_change' | null;

export type ChatTodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type ChatToolEventStatus = 'start' | 'progress' | 'end' | 'error';

export type ChatAssistantBlock =
  | {
      kind: 'text';
      blockId: string;
      phase: 'delta' | 'end';
      text?: string;
    }
  | {
      kind: 'reasoning';
      blockId: string;
      phase: 'delta' | 'end';
      text?: string;
    }
  | {
      kind: 'tool_call';
      blockId: string;
      callId: string;
      name: string;
      phase: ChatToolEventStatus;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    };

export type SubagentExecution = 'sync' | 'async';

export type SubagentStatus = 'started' | 'running' | 'completed' | 'failed' | 'cancelled';

export type SubagentIdentity = {
  subagentId: string;
  parentSubagentId: string | null;
  name: string;
  depth: number;
  path: string[];
  execution: SubagentExecution;
  taskInput: string | null;
  asyncTaskId?: string;
};

export type SubagentEventPayload =
  | { kind: 'started' }
  | { kind: 'assistant_block'; block: ChatAssistantBlock }
  | { kind: 'tool_call'; block: Extract<ChatAssistantBlock, { kind: 'tool_call' }> }
  | { kind: 'async_status'; status: AsyncTaskStatus; checkedAt?: string }
  | { kind: 'completed'; summary: string | null }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason?: string };

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
      type: 'assistant_block';
      runId: string;
      block: ChatAssistantBlock;
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
      type: 'todo_event';
      runId: string;
      todos: ChatTodoItem[];
    }
  | {
      type: 'subagent_event';
      runId: string;
      sequence: number;
      identity: SubagentIdentity;
      event: SubagentEventPayload;
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
  taskSource?: 'workbench' | null;
  workspacePath?: string | null;
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
