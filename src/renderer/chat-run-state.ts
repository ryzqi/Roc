import type { ChatPendingApproval, ChatRunEvent, ChatRunMode, ChatTodoItem } from '../shared/types';

export type ChatRunToolState = {
  name: string;
  event: 'start' | 'progress' | 'end' | 'error';
  data: unknown;
};

export type ChatRunSubagentState = {
  subagent: string;
  status: 'started' | 'completed' | 'failed';
  summary: string | null;
};

export type ChatRunState = {
  runId: string | null;
  mode: ChatRunMode | null;
  threadId: string | null;
  providerId: string | null;
  modelId: string | null;
  createdAt: string | null;
  status: 'idle' | 'running' | 'waiting_user' | 'completed' | 'failed';
  assistantMessage: string;
  reasoning: string;
  durationMs: number | null;
  summary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  pendingApprovals: ChatPendingApproval[];
  resumeBusy: boolean;
  toolEvents: ChatRunToolState[];
  todos: ChatTodoItem[];
  subagents: ChatRunSubagentState[];
};

export function createEmptyChatRunState(): ChatRunState {
  return {
    runId: null,
    mode: null,
    threadId: null,
    providerId: null,
    modelId: null,
    createdAt: null,
    status: 'idle',
    assistantMessage: '',
    reasoning: '',
    durationMs: null,
    summary: null,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    pendingApprovals: [],
    resumeBusy: false,
    toolEvents: [],
    todos: [],
    subagents: []
  };
}

export function applyChatRunEvent(state: ChatRunState, event: ChatRunEvent): ChatRunState {
  if (event.type === 'run_started') {
    return {
      runId: event.runId,
      mode: event.mode,
      threadId: event.threadId,
      providerId: event.providerId,
      modelId: event.modelId,
      createdAt: event.createdAt,
      status: 'running',
      assistantMessage: '',
      reasoning: '',
      durationMs: null,
      summary: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      pendingApprovals: [],
      resumeBusy: false,
      toolEvents: [],
      todos: [],
      subagents: []
    };
  }

  if (state.runId !== event.runId) {
    return state;
  }

  if (event.type === 'message_delta') {
    return {
      ...state,
      assistantMessage: `${state.assistantMessage}${event.delta}`
    };
  }

  if (event.type === 'reasoning_delta') {
    return {
      ...state,
      reasoning: `${state.reasoning}${event.delta}`
    };
  }

  if (event.type === 'tool_event') {
    return {
      ...state,
      toolEvents: [...state.toolEvents, { name: event.name, event: event.event, data: event.data }]
    };
  }

  if (event.type === 'todo_event') {
    return {
      ...state,
      todos: event.todos
    };
  }

  if (event.type === 'subagent_event') {
    return {
      ...state,
      subagents: [
        ...state.subagents.filter((item) => item.subagent !== event.subagent),
        {
          subagent: event.subagent,
          status: event.status,
          summary: event.summary
        }
      ]
    };
  }

  if (event.type === 'run_completed') {
    return {
      ...state,
      threadId: event.threadId,
      providerId: event.providerId,
      modelId: event.modelId,
      createdAt: event.createdAt,
      status: 'completed',
      assistantMessage: event.assistantMessage,
      durationMs: event.durationMs,
      summary: event.summary,
      pendingApprovals: [],
      resumeBusy: false
    };
  }

  if (event.type === 'run_interrupted') {
    return {
      ...state,
      threadId: event.threadId,
      status: 'waiting_user',
      pendingApprovals: [
        Object.assign({ interruptId: event.interruptId }, event.payload)
      ],
      resumeBusy: false
    };
  }

  if (event.type === 'run_resumed') {
    return {
      ...state,
      threadId: event.threadId,
      status: 'running',
      pendingApprovals: state.pendingApprovals.filter((approval) => approval.interruptId !== event.interruptId),
      resumeBusy: false
    };
  }

  if (event.type === 'run_failed') {
    return {
      ...state,
      threadId: event.threadId,
      status: 'failed',
      errorCode: event.code,
      errorMessage: event.message,
      retryable: event.retryable,
      resumeBusy: false
    };
  }

  return state;
}
