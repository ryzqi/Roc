import type { ChatAssistantBlock, ChatPendingApproval, ChatRunEvent, ChatRunMode, ChatTodoItem } from '../shared/types';

export type ChatRunToolStatus = 'start' | 'progress' | 'end' | 'error';

export type ChatRunActivityBlock =
  | {
      id: string;
      kind: 'reasoning';
      content: string;
    }
  | {
      id: string;
      kind: 'tool_call';
      callId: string;
      name: string;
      status: ChatRunToolStatus;
      input: unknown;
      output: unknown;
      error: unknown;
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
  activityBlocks: ChatRunActivityBlock[];
  durationMs: number | null;
  summary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  pendingApprovals: ChatPendingApproval[];
  resumeBusy: boolean;
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
    activityBlocks: [],
    durationMs: null,
    summary: null,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    pendingApprovals: [],
    resumeBusy: false,
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
      activityBlocks: [],
      durationMs: null,
      summary: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      pendingApprovals: [],
      resumeBusy: false,
      todos: [],
      subagents: []
    };
  }

  if (state.runId !== event.runId) {
    return state;
  }

  if (event.type === 'assistant_block') {
    return applyAssistantBlock(state, event.block);
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

function applyAssistantBlock(state: ChatRunState, block: ChatAssistantBlock): ChatRunState {
  if (block.kind === 'text') {
    if (typeof block.text !== 'string') {
      return state;
    }
    return {
      ...state,
      assistantMessage: `${state.assistantMessage}${block.text}`
    };
  }
  if (block.kind === 'reasoning') {
    return {
      ...state,
      activityBlocks: appendReasoningBlock(state.activityBlocks, block)
    };
  }
  return {
    ...state,
    activityBlocks: applyToolBlock(state.activityBlocks, block)
  };
}

function appendReasoningBlock(
  blocks: readonly ChatRunActivityBlock[],
  block: Extract<ChatAssistantBlock, { kind: 'reasoning' }>
): ChatRunActivityBlock[] {
  if (typeof block.text !== 'string') {
    return [...blocks];
  }
  const existing = blocks.find((item): item is Extract<ChatRunActivityBlock, { kind: 'reasoning' }> => item.kind === 'reasoning' && item.id === block.blockId);
  if (existing === undefined) {
    return [
      ...blocks,
      {
        id: block.blockId,
        kind: 'reasoning',
        content: block.text
      }
    ];
  }
  return blocks.map((item) =>
    item === existing
      ? {
          ...item,
          content: `${item.content}${block.text}`
        }
      : item
  );
}

function applyToolBlock(
  blocks: readonly ChatRunActivityBlock[],
  block: Extract<ChatAssistantBlock, { kind: 'tool_call' }>
): ChatRunActivityBlock[] {
  const existing = blocks.find((item): item is Extract<ChatRunActivityBlock, { kind: 'tool_call' }> => item.kind === 'tool_call' && item.id === block.blockId);
  const nextBlock: Extract<ChatRunActivityBlock, { kind: 'tool_call' }> = {
    id: block.blockId,
    kind: 'tool_call',
    callId: block.callId,
    name: block.name,
    status: block.phase,
    input: existing === undefined ? null : existing.input,
    output: existing === undefined ? null : existing.output,
    error: existing === undefined ? null : existing.error
  };
  if ('input' in block) {
    nextBlock.input = block.input;
  }
  if ('output' in block) {
    nextBlock.output = block.output;
  }
  if ('error' in block) {
    nextBlock.error = block.error;
  }
  if (existing === undefined) {
    return [...blocks, nextBlock];
  }
  return blocks.map((item) => (item === existing ? nextBlock : item));
}
