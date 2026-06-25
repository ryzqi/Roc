import type {
  ChatAssistantBlock,
  ChatPendingApproval,
  ChatRunEvent,
  ChatRunMode,
  ChatTodoItem,
  RocHookRunSummary,
  SubagentEventPayload,
  SubagentIdentity,
  SubagentStatus
} from '../shared/types';

type ChatRunToolStatus = 'start' | 'progress' | 'end' | 'error';

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
    }
  | {
      id: string;
      kind: 'hook_call';
      event: RocHookRunSummary['event'];
      handlerId: string;
      status: RocHookRunSummary['status'];
      durationMs: number | null;
      message: string | null;
      commandDisplay: string;
    };

export type ChatRunSubagentBlock =
  | {
      id: string;
      kind: 'text';
      content: string;
    }
  | Extract<ChatRunActivityBlock, { kind: 'reasoning' }>
  | Extract<ChatRunActivityBlock, { kind: 'tool_call' }>;

export type ChatRunSubagentNode = {
  identity: SubagentIdentity;
  status: SubagentStatus;
  summary: string | null;
  error: string | null;
  blocks: ChatRunSubagentBlock[];
  children: ChatRunSubagentNode[];
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
  subagents: ChatRunSubagentNode[];
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
      subagents: upsertSubagentNode(state.subagents, event.identity.parentSubagentId, event.identity, event.event)
    };
  }

  if (event.type === 'hook_started' || event.type === 'hook_completed') {
    return {
      ...state,
      activityBlocks: upsertHookActivityBlock(state.activityBlocks, event.hook)
    };
  }

  if (event.type === 'run_completed') {
    const completedEvent = event;
    return {
      ...state,
      threadId: completedEvent.threadId,
      providerId: completedEvent.providerId,
      modelId: completedEvent.modelId,
      createdAt: completedEvent.createdAt,
      status: 'completed',
      assistantMessage: completedEvent.assistantMessage,
      durationMs: completedEvent.durationMs,
      summary: completedEvent.summary,
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

function upsertHookActivityBlock(blocks: readonly ChatRunActivityBlock[], hook: RocHookRunSummary): ChatRunActivityBlock[] {
  const nextBlock: Extract<ChatRunActivityBlock, { kind: 'hook_call' }> = {
    id: hook.runId,
    kind: 'hook_call',
    event: hook.event,
    handlerId: hook.handlerId,
    status: hook.status,
    durationMs: hook.durationMs,
    message: hook.message,
    commandDisplay: hook.commandDisplay
  };
  const existing = blocks.find((item): item is Extract<ChatRunActivityBlock, { kind: 'hook_call' }> => item.kind === 'hook_call' && item.id === hook.runId);
  if (existing === undefined) {
    return [...blocks, nextBlock];
  }
  return blocks.map((item) => (item === existing ? nextBlock : item));
}

function upsertSubagentNode(
  nodes: readonly ChatRunSubagentNode[],
  parentSubagentId: string | null,
  identity: SubagentIdentity,
  payload: SubagentEventPayload
): ChatRunSubagentNode[] {
  if (parentSubagentId !== null) {
    return nodes.map((node) =>
      node.identity.subagentId === parentSubagentId
        ? { ...node, children: upsertSubagentNode(node.children, null, identity, payload) }
        : { ...node, children: upsertSubagentNode(node.children, parentSubagentId, identity, payload) }
    );
  }

  const existing = nodes.find((node) => node.identity.subagentId === identity.subagentId);
  const next = applySubagentEvent(
    existing ?? {
      identity,
      status: 'started',
      summary: null,
      error: null,
      blocks: [],
      children: []
    },
    payload
  );
  return existing === undefined ? [...nodes, next] : nodes.map((node) => (node === existing ? next : node));
}

function applySubagentEvent(node: ChatRunSubagentNode, payload: SubagentEventPayload): ChatRunSubagentNode {
  if (payload.kind === 'started') {
    return {
      ...node,
      status: 'started'
    };
  }
  if (payload.kind === 'assistant_block') {
    return {
      ...node,
      status: node.status === 'started' ? 'running' : node.status,
      blocks: appendSubagentAssistantBlock(node.blocks, payload.block)
    };
  }
  if (payload.kind === 'tool_call') {
    return {
      ...node,
      status: node.status === 'started' ? 'running' : node.status,
      blocks: appendSubagentToolBlock(node.blocks, payload.block)
    };
  }
  if (payload.kind === 'async_status') {
    return {
      ...node,
      status: 'running'
    };
  }
  if (payload.kind === 'completed') {
    return {
      ...node,
      status: 'completed',
      summary: payload.summary
    };
  }
  if (payload.kind === 'failed') {
    return {
      ...node,
      status: 'failed',
      error: payload.error
    };
  }
  return {
    ...node,
    status: 'cancelled',
    error: payload.reason ?? null
  };
}

function appendSubagentAssistantBlock(
  blocks: readonly ChatRunSubagentBlock[],
  block: ChatAssistantBlock
): ChatRunSubagentBlock[] {
  if (block.kind === 'text') {
    if (typeof block.text !== 'string') {
      return [...blocks];
    }
    const existing = blocks.find((item): item is Extract<ChatRunSubagentBlock, { kind: 'text' }> => item.kind === 'text' && item.id === block.blockId);
    if (existing === undefined) {
      return [
        ...blocks,
        {
          id: block.blockId,
          kind: 'text',
          content: block.text
        }
      ];
    }
    return blocks.map((item) => (item === existing ? { ...item, content: `${item.content}${block.text}` } : item));
  }
  if (block.kind === 'reasoning') {
    return appendSubagentReasoningBlock(blocks, block);
  }
  return appendSubagentToolBlock(blocks, block);
}

function appendSubagentReasoningBlock(
  blocks: readonly ChatRunSubagentBlock[],
  block: Extract<ChatAssistantBlock, { kind: 'reasoning' }>
): ChatRunSubagentBlock[] {
  if (typeof block.text !== 'string') {
    return [...blocks];
  }
  const existing = blocks.find((item): item is Extract<ChatRunSubagentBlock, { kind: 'reasoning' }> => item.kind === 'reasoning' && item.id === block.blockId);
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
  return blocks.map((item) => (item === existing ? { ...item, content: `${item.content}${block.text}` } : item));
}

function appendSubagentToolBlock(
  blocks: readonly ChatRunSubagentBlock[],
  block: Extract<ChatAssistantBlock, { kind: 'tool_call' }>
): ChatRunSubagentBlock[] {
  const existing = blocks.find((item): item is Extract<ChatRunSubagentBlock, { kind: 'tool_call' }> => item.kind === 'tool_call' && item.id === block.blockId);
  const nextBlock: Extract<ChatRunSubagentBlock, { kind: 'tool_call' }> = {
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
