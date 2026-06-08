import type { ChatPendingApproval, TaskEvent, TaskSnapshot } from '../shared/types';
import type { ChatRunState, ChatRunSubagentState, ChatRunToolState } from './chat-run-state';

export type ChatTranscriptActivityBlock =
  | {
      id: string;
      kind: 'reasoning';
      content: string;
      isStreaming: boolean;
    }
  | {
      id: string;
      kind: 'tool_call';
      name: string;
      status: ChatRunToolState['event'];
      input: unknown;
      output: unknown;
      error: unknown;
    }
  | {
      id: string;
      kind: 'subagent';
      name: string;
      status: ChatRunSubagentState['status'];
      summary: string | null;
    }
  | {
      id: string;
      kind: 'guardrail';
      nudgeKind: string;
      content: string;
      tier: number | null;
      toolName: string | null;
    };

export type ChatTranscriptMessage = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  blocks: ChatTranscriptActivityBlock[];
  approval: ChatPendingApproval | null;
  isStreaming: boolean;
};

type MessagePayload = {
  role: 'user' | 'assistant';
  content: string;
};

type MessageDeltaPayload = {
  role?: 'assistant';
  delta: string;
};

type ReasoningDeltaPayload = {
  delta: string;
};

type ToolCallPayload = {
  name: string;
  status: ChatRunToolState['event'];
  input?: unknown;
  output?: unknown;
  error?: unknown;
};

type SubagentPayload = {
  name: string;
  summary?: string | null;
};

type GuardrailPayload = {
  nudgeKind: string;
  content: string;
  tier?: number;
  toolName?: string;
};

type ApprovalDecisionPayload = {
  interruptId: string;
  decisions: unknown[];
};

type AssistantDraft = {
  message: ChatTranscriptMessage;
  reasoningBlock: Extract<ChatTranscriptActivityBlock, { kind: 'reasoning' }> | null;
  toolBlocks: Array<Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>>;
  subagentBlocks: Array<Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>>;
};

type MessageTaskEvent = TaskEvent & {
  type: 'message';
  payload: MessagePayload;
};

function isMessagePayload(payload: unknown): payload is MessagePayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const role = Reflect.get(payload, 'role');
  const content = Reflect.get(payload, 'content');
  return (role === 'user' || role === 'assistant') && typeof content === 'string';
}

function isMessageTaskEvent(event: TaskEvent, threadId: string): event is MessageTaskEvent {
  return event.threadId === threadId && event.type === 'message' && isMessagePayload(event.payload);
}

function isMessageDeltaPayload(payload: unknown): payload is MessageDeltaPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const role = Reflect.get(payload, 'role');
  const delta = Reflect.get(payload, 'delta');
  return (role === undefined || role === 'assistant') && typeof delta === 'string';
}

function isReasoningDeltaPayload(payload: unknown): payload is ReasoningDeltaPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  return typeof Reflect.get(payload, 'delta') === 'string';
}

function isToolCallPayload(payload: unknown): payload is ToolCallPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const name = Reflect.get(payload, 'name');
  const status = Reflect.get(payload, 'status');
  return (
    typeof name === 'string' &&
    (status === 'start' || status === 'progress' || status === 'end' || status === 'error')
  );
}

function isSubagentPayload(payload: unknown): payload is SubagentPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const name = Reflect.get(payload, 'name');
  const summary = Reflect.get(payload, 'summary');
  return typeof name === 'string' && (summary === undefined || summary === null || typeof summary === 'string');
}

function isGuardrailPayload(payload: unknown): payload is GuardrailPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const nudgeKind = Reflect.get(payload, 'nudgeKind');
  const content = Reflect.get(payload, 'content');
  const tier = Reflect.get(payload, 'tier');
  const toolName = Reflect.get(payload, 'toolName');
  return (
    typeof nudgeKind === 'string' &&
    typeof content === 'string' &&
    (tier === undefined || typeof tier === 'number') &&
    (toolName === undefined || typeof toolName === 'string')
  );
}

function isApprovalPayload(payload: unknown): payload is ChatPendingApproval {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const interruptId = Reflect.get(payload, 'interruptId');
  const actionRequests = Reflect.get(payload, 'actionRequests');
  const reviewConfigs = Reflect.get(payload, 'reviewConfigs');
  return typeof interruptId === 'string' && Array.isArray(actionRequests) && Array.isArray(reviewConfigs);
}

function isApprovalDecisionPayload(payload: unknown): payload is ApprovalDecisionPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const interruptId = Reflect.get(payload, 'interruptId');
  const decisions = Reflect.get(payload, 'decisions');
  return typeof interruptId === 'string' && Array.isArray(decisions);
}

function resolveActiveThreadId(selectedThreadId: string | null, chatRunState: ChatRunState): string | null {
  if (selectedThreadId !== null) {
    return selectedThreadId;
  }
  return chatRunState.threadId;
}

function compareTaskEventsAscending(left: TaskEvent, right: TaskEvent): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  return (left.sequence === undefined ? 0 : left.sequence) - (right.sequence === undefined ? 0 : right.sequence);
}

function createUserMessage(event: MessageTaskEvent): ChatTranscriptMessage {
  return {
    key: event.id,
    role: 'user',
    content: event.payload.content,
    reasoning: null,
    blocks: [],
    approval: null,
    isStreaming: false
  };
}

function createAssistantDraft(runId: string): AssistantDraft {
  return {
    message: {
      key: `assistant-${runId}`,
      role: 'assistant',
      content: '',
      reasoning: null,
      blocks: [],
      approval: null,
      isStreaming: false
    },
    reasoningBlock: null,
    toolBlocks: [],
    subagentBlocks: []
  };
}

function getAssistantDraft(
  drafts: Map<string, AssistantDraft>,
  messages: ChatTranscriptMessage[],
  runId: string
): AssistantDraft {
  const existing = drafts.get(runId);
  if (existing !== undefined) {
    return existing;
  }

  const draft = createAssistantDraft(runId);
  drafts.set(runId, draft);
  messages.push(draft.message);
  return draft;
}

function appendReasoningBlock(draft: AssistantDraft, delta: string, isStreaming: boolean): void {
  draft.message.reasoning = `${draft.message.reasoning ?? ''}${delta}`;
  if (draft.reasoningBlock === null) {
    draft.reasoningBlock = {
      id: `reasoning-${draft.message.key.replace(/^assistant-/, '')}`,
      kind: 'reasoning',
      content: '',
      isStreaming
    };
    draft.message.blocks.push(draft.reasoningBlock);
  }
  draft.reasoningBlock.content += delta;
  draft.reasoningBlock.isStreaming = isStreaming;
}

function applyToolCallBlock(draft: AssistantDraft, payload: ToolCallPayload, idPrefix: string): void {
  const activeTool =
    payload.status === 'start'
      ? null
      : [...draft.toolBlocks].reverse().find((block) => block.name === payload.name && block.status !== 'end' && block.status !== 'error') ?? null;
  const block =
    activeTool ??
    ({
      id: `${idPrefix}-${draft.toolBlocks.length}`,
      kind: 'tool_call',
      name: payload.name,
      status: payload.status,
      input: null,
      output: null,
      error: null
    } satisfies Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>);

  if (activeTool === null) {
    draft.toolBlocks.push(block);
    draft.message.blocks.push(block);
  }
  block.status = payload.status;
  if ('input' in payload) {
    block.input = payload.input;
  }
  if ('output' in payload) {
    block.output = payload.output;
  }
  if ('error' in payload) {
    block.error = payload.error;
  }
}

function applySubagentBlock(
  draft: AssistantDraft,
  payload: SubagentPayload,
  status: ChatRunSubagentState['status'],
  idPrefix: string
): void {
  const existing = draft.subagentBlocks.find((block) => block.name === payload.name);
  if (existing !== undefined) {
    existing.status = status;
    existing.summary = payload.summary ?? null;
    return;
  }
  const block: Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }> = {
    id: `${idPrefix}-subagent-${draft.subagentBlocks.length}`,
    kind: 'subagent',
    name: payload.name,
    status,
    summary: payload.summary ?? null
  };
  draft.subagentBlocks.push(block);
  draft.message.blocks.push(block);
}

function appendGuardrailBlock(draft: AssistantDraft, payload: GuardrailPayload, idPrefix: string): void {
  draft.message.blocks.push({
    id: `${idPrefix}-guardrail-${draft.message.blocks.length}`,
    kind: 'guardrail',
    nudgeKind: payload.nudgeKind,
    content: payload.content,
    tier: payload.tier ?? null,
    toolName: payload.toolName ?? null
  });
}

function buildPersistedTranscriptMessages(recentEvents: TaskEvent[], threadId: string): ChatTranscriptMessage[] {
  const messages: ChatTranscriptMessage[] = [];
  const drafts = new Map<string, AssistantDraft>();

  for (const event of recentEvents
    .filter((candidate) => candidate.threadId === threadId)
    .slice()
    .sort(compareTaskEventsAscending)) {
    if (isMessageTaskEvent(event, threadId)) {
      if (event.payload.role === 'user') {
        messages.push(createUserMessage(event));
        continue;
      }

      const draft = getAssistantDraft(drafts, messages, event.runId);
      draft.message.key = event.id;
      draft.message.content = event.payload.content;
      continue;
    }

    if (event.type === 'message_delta' && isMessageDeltaPayload(event.payload)) {
      const draft = getAssistantDraft(drafts, messages, event.runId);
      draft.message.content += event.payload.delta;
      continue;
    }

    if (event.type === 'reasoning_delta' && isReasoningDeltaPayload(event.payload)) {
      appendReasoningBlock(getAssistantDraft(drafts, messages, event.runId), event.payload.delta, false);
      continue;
    }

    if (event.type === 'tool_call' && isToolCallPayload(event.payload)) {
      applyToolCallBlock(getAssistantDraft(drafts, messages, event.runId), event.payload, `tool-${event.runId}`);
      continue;
    }

    if (event.type === 'subagent_started' && isSubagentPayload(event.payload)) {
      applySubagentBlock(getAssistantDraft(drafts, messages, event.runId), event.payload, 'started', `subagent-${event.runId}`);
      continue;
    }

    if (event.type === 'subagent_completed' && isSubagentPayload(event.payload)) {
      applySubagentBlock(getAssistantDraft(drafts, messages, event.runId), event.payload, 'completed', `subagent-${event.runId}`);
      continue;
    }

    if (event.type === 'guardrail_nudge' && isGuardrailPayload(event.payload)) {
      appendGuardrailBlock(getAssistantDraft(drafts, messages, event.runId), event.payload, `guardrail-${event.runId}`);
      continue;
    }

    if (event.type === 'approval_requested' && isApprovalPayload(event.payload)) {
      getAssistantDraft(drafts, messages, event.runId).message.approval = event.payload;
      continue;
    }

    if (event.type === 'approval_decision' && isApprovalDecisionPayload(event.payload)) {
      getAssistantDraft(drafts, messages, event.runId).message.approval = null;
    }
  }

  return messages.filter(
    (message) => message.role === 'user' || message.content.length > 0 || message.blocks.length > 0 || message.approval !== null
  );
}

function buildToolBlocksFromLiveState(toolEvents: readonly ChatRunToolState[], idPrefix: string): ChatTranscriptActivityBlock[] {
  const blocks: Array<Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>> = [];
  for (const event of toolEvents) {
    const activeTool =
      event.event === 'start'
        ? null
        : [...blocks].reverse().find((block) => block.name === event.name && block.status !== 'end' && block.status !== 'error') ?? null;
    const block =
      activeTool ??
      ({
        id: `${idPrefix}-tool-${blocks.length}`,
        kind: 'tool_call',
        name: event.name,
        status: event.event,
        input: null,
        output: null,
        error: null
      } satisfies Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>);

    if (activeTool === null) {
      blocks.push(block);
    }
    block.status = event.event;
    if (event.event === 'end') {
      block.output = event.data;
    } else if (event.event === 'error') {
      block.error = event.data;
    } else {
      block.input = event.data;
    }
  }
  return blocks;
}

function buildLiveActivityBlocks(chatRunState: ChatRunState): ChatTranscriptActivityBlock[] {
  const idPrefix = `live-${chatRunState.runId ?? 'assistant'}`;
  const blocks: ChatTranscriptActivityBlock[] = [];
  if (chatRunState.reasoning.length > 0) {
    blocks.push({
      id: `${idPrefix}-reasoning`,
      kind: 'reasoning',
      content: chatRunState.reasoning,
      isStreaming: chatRunState.status === 'running'
    });
  }
  blocks.push(...buildToolBlocksFromLiveState(chatRunState.toolEvents, idPrefix));
  chatRunState.subagents.forEach((subagent, index) => {
    blocks.push({
      id: `${idPrefix}-subagent-${index}`,
      kind: 'subagent',
      name: subagent.subagent,
      status: subagent.status,
      summary: subagent.summary
    });
  });
  return blocks;
}

export function buildChatTranscript(input: {
  promotedThreadIds: Set<string>;
  chatRunState: ChatRunState;
  pendingUserInput: string | null;
  persistedMessages?: TaskEvent[];
  selectedThreadId: string | null;
  taskSnapshot: TaskSnapshot;
}): ChatTranscriptMessage[] {
  const activeThreadId = resolveActiveThreadId(input.selectedThreadId, input.chatRunState);
  if (activeThreadId === null) {
    return input.pendingUserInput === null
      ? []
      : [
          {
            key: 'pending-user-message',
            role: 'user',
            content: input.pendingUserInput,
            reasoning: null,
            blocks: [],
            approval: null,
            isStreaming: false
          }
      ];
  }

  const persistedMessageEvents = input.persistedMessages ?? input.taskSnapshot.recentEvents;
  const messages = buildPersistedTranscriptMessages(persistedMessageEvents, activeThreadId);
  if (input.promotedThreadIds.has(activeThreadId) && input.chatRunState.threadId !== activeThreadId) {
    return messages;
  }
  if (input.pendingUserInput !== null && !messages.some((message) => message.role === 'user' && message.content === input.pendingUserInput)) {
    messages.push({
      key: 'pending-user-message',
      role: 'user',
      content: input.pendingUserInput,
      reasoning: null,
      blocks: [],
      approval: null,
      isStreaming: false
    });
  }

  if (input.chatRunState.threadId !== activeThreadId) {
    return messages;
  }

  const liveContent = input.chatRunState.assistantMessage;
  const liveReasoning = input.chatRunState.reasoning;
  const liveBlocks = buildLiveActivityBlocks(input.chatRunState);
  const lastAssistantIndex = [...messages].reverse().findIndex((message) => message.role === 'assistant');
  const assistantIndex = lastAssistantIndex === -1 ? -1 : messages.length - 1 - lastAssistantIndex;
  const matchesPersistedAssistant =
    assistantIndex !== -1 &&
    messages[assistantIndex].content === liveContent &&
    input.chatRunState.status !== 'running';

  if (matchesPersistedAssistant) {
    messages[assistantIndex] = {
      ...messages[assistantIndex],
      reasoning: liveReasoning.length === 0 ? null : liveReasoning,
      blocks: liveBlocks.length === 0 ? messages[assistantIndex].blocks : liveBlocks,
      approval: input.chatRunState.pendingApprovals[0] ?? null,
      isStreaming: false
    };
    return messages;
  }

  if (
    liveContent.length === 0 &&
    liveReasoning.length === 0 &&
    liveBlocks.length === 0 &&
    input.chatRunState.pendingApprovals.length === 0
  ) {
    return messages;
  }

  messages.push({
    key: `live-${input.chatRunState.runId ?? 'assistant'}`,
    role: 'assistant',
    content: liveContent,
    reasoning: liveReasoning.length === 0 ? null : liveReasoning,
    blocks: liveBlocks,
    approval: input.chatRunState.pendingApprovals[0] ?? null,
    isStreaming: input.chatRunState.status === 'running'
  });
  return messages;
}
