import type { AsyncTaskStatus } from 'deepagents';
import type { HITLRequest, HITLResponse } from 'langchain';
import type { EnabledCapabilities } from './agent';
import type { RocHookRunEvent } from './hooks';

export type ChatRunMode = 'chat' | 'task' | 'plan';

export type WorkflowHint = 'propose_background_task' | 'background_task_change' | null;

export const chatImageAttachmentMediaTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type ChatImageAttachmentMediaType = (typeof chatImageAttachmentMediaTypes)[number];

export type ChatImageAttachment = {
  kind: 'image';
  source: 'file' | 'clipboard' | 'drop';
  name: string;
  mediaType: ChatImageAttachmentMediaType;
  sizeBytes: number;
  path?: string;
  data?: string;
};

export type ChatPersistedAttachment = {
  kind: 'image';
  name: string;
  mediaType: ChatImageAttachmentMediaType;
  sizeBytes: number;
};

export type ChatValidatedImageAttachment = ChatPersistedAttachment & {
  base64: string;
};

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

export type ChatApprovalInterruptPayload = {
  kind: 'approval';
  request: HITLRequest;
};

export type ChatQuestionInterruptPayload = {
  kind: 'question';
  question: string;
  context?: string;
  suggestedResponses?: string[];
};

export type ChatInterruptPayload = ChatApprovalInterruptPayload | ChatQuestionInterruptPayload;

export type ChatPendingApproval = HITLRequest & {
  kind: 'approval';
  interruptId: string;
};

export type ChatPendingQuestion = ChatQuestionInterruptPayload & {
  interruptId: string;
};

export type ChatPendingInterrupt = ChatPendingApproval | ChatPendingQuestion;

export type ChatResumeDecision = HITLResponse['decisions'][number];

export type ChatResumeRunRequest =
  | {
      kind: 'approval';
      runId: string;
      threadId: string;
      interruptId: string;
      decisions: ChatResumeDecision[];
    }
  | {
      kind: 'question';
      runId: string;
      threadId: string;
      interruptId: string;
      answer: string;
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
      payload: ChatInterruptPayload;
    }
  | {
      type: 'run_resumed';
      runId: string;
      threadId: string | null;
      interruptId: string;
    }
  | {
      type: 'run_recovering';
      runId: string;
      threadId: string | null;
      code: string;
      message: string;
      attempt: number;
      nextRetryAt: string;
    }
  | {
      type: 'run_recovered';
      runId: string;
      threadId: string | null;
      attempt: number;
      recoveredAt: string;
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
      type: 'context_maintenance';
      runId: string;
      threadId: string | null;
      event:
        | 'context_compaction_started'
        | 'context_tool_result_persisted'
        | 'context_deterministic_compacted'
        | 'context_summary_started'
        | 'context_summary_completed'
        | 'context_summary_skipped'
        | 'context_compaction_failed';
      mode: ChatRunMode;
      stage: 'persist' | 'deterministic' | 'summary';
      persistedChars?: number;
      removedChars?: number;
      inputTokens?: number;
      budgetTokens?: number;
      estimated?: boolean;
    }
  | RocHookRunEvent
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
      type: 'run_cancelled';
      runId: string;
      threadId: string | null;
      reason: 'user_cancelled';
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

export type SequencedChatRunEvent = {
  runId: string;
  sequence: number;
  event: ChatRunEvent;
  createdAt: string;
};

export type ChatRunEventsReplayRequest = {
  runId: string;
  afterSequence: number;
};

export type ChatRunEventsReplayResult = {
  runId: string;
  events: SequencedChatRunEvent[];
};

export type ActiveChatRun = {
  runId: string;
  threadId: string;
  status: 'running' | 'recovering' | 'waiting_user';
};

export type ChatStartRunRequest = {
  input: string;
  mode: ChatRunMode;
  enabledCapabilities: EnabledCapabilities;
  threadId?: string | null;
  workflowHint?: WorkflowHint;
  taskSource?: 'background_schedule' | 'workbench' | null;
  workspacePath?: string | null;
  /** 仅由任务插件内部调度传入；renderer IPC adapter 会移除此字段。 */
  shellAllowedCommands?: string[];
  attachments?: ChatImageAttachment[];
  dispatchKey?: string;
  explicitSkillIds?: string[];
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
