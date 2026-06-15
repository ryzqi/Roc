import type { ChatAssistantBlock, ChatPendingApproval, TaskEvent, TaskSnapshot } from '../shared/types';
import type { ChatRunActivityBlock, ChatRunState, ChatRunSubagentState } from './chat-run-state';

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
      status: Extract<ChatRunActivityBlock, { kind: 'tool_call' }>['status'];
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

function isAssistantBlockPayload(payload: unknown): payload is ChatAssistantBlock {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const kind = Reflect.get(payload, 'kind');
  const blockId = Reflect.get(payload, 'blockId');
  const phase = Reflect.get(payload, 'phase');
  if (typeof blockId !== 'string') {
    return false;
  }
  if (kind === 'text' || kind === 'reasoning') {
    const text = Reflect.get(payload, 'text');
    return (phase === 'delta' || phase === 'end') && (text === undefined || typeof text === 'string');
  }
  if (kind !== 'tool_call') {
    return false;
  }
  const callId = Reflect.get(payload, 'callId');
  const name = Reflect.get(payload, 'name');
  return typeof callId === 'string' && typeof name === 'string' && isToolPhase(phase);
}

function isToolPhase(value: unknown): value is Extract<ChatRunActivityBlock, { kind: 'tool_call' }>['status'] {
  return value === 'start' || value === 'progress' || value === 'end' || value === 'error';
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

function applyAssistantBlock(draft: AssistantDraft, block: ChatAssistantBlock, isStreaming: boolean): void {
  if (block.kind === 'text') {
    if (typeof block.text === 'string') {
      draft.message.content += block.text;
    }
    return;
  }
  if (block.kind === 'reasoning') {
    if (typeof block.text === 'string') {
      appendReasoningBlock(draft, block.blockId, block.text, isStreaming);
    }
    return;
  }
  applyToolCallBlock(draft, block);
}

function appendReasoningBlock(draft: AssistantDraft, blockId: string, delta: string, isStreaming: boolean): void {
  draft.message.reasoning = `${draft.message.reasoning ?? ''}${delta}`;
  if (draft.reasoningBlock === null) {
    draft.reasoningBlock = {
      id: blockId,
      kind: 'reasoning',
      content: '',
      isStreaming
    };
    draft.message.blocks.push(draft.reasoningBlock);
  }
  draft.reasoningBlock.content += delta;
  draft.reasoningBlock.isStreaming = isStreaming;
}

function applyToolCallBlock(draft: AssistantDraft, payload: Extract<ChatAssistantBlock, { kind: 'tool_call' }>): void {
  const activeTool = draft.toolBlocks.find((block) => block.id === payload.blockId);
  const block =
    activeTool === undefined
      ? ({
          id: payload.blockId,
          kind: 'tool_call',
          name: payload.name,
          status: payload.phase,
          input: null,
          output: null,
          error: null
        } satisfies Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>)
      : activeTool;

  if (activeTool === undefined) {
    draft.toolBlocks.push(block);
    draft.message.blocks.push(block);
  }
  block.status = payload.phase;
  block.name = payload.name;
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

export function buildPersistedTranscriptMessages(recentEvents: TaskEvent[], threadId: string): ChatTranscriptMessage[] {
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

    if (event.type === 'assistant_block' && isAssistantBlockPayload(event.payload)) {
      applyAssistantBlock(getAssistantDraft(drafts, messages, event.runId), event.payload, false);
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

function buildLiveActivityBlocks(chatRunState: ChatRunState): ChatTranscriptActivityBlock[] {
  const idPrefix = chatRunState.runId === null ? 'live-assistant' : `live-${chatRunState.runId}`;
  const blocks: ChatTranscriptActivityBlock[] = chatRunState.activityBlocks.map((block) => {
    if (block.kind === 'reasoning') {
      return {
        id: block.id,
        kind: 'reasoning',
        content: block.content,
        isStreaming: chatRunState.status === 'running'
      };
    }
    return {
      id: block.id,
      kind: 'tool_call',
      name: block.name,
      status: block.status,
      input: block.input,
      output: block.output,
      error: block.error
    };
  });
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

function readReasoningFromBlocks(blocks: readonly ChatTranscriptActivityBlock[]): string {
  return blocks.flatMap((block) => (block.kind === 'reasoning' ? [block.content] : [])).join('');
}

function createPendingUserMessage(content: string): ChatTranscriptMessage {
  return {
    key: 'pending-user-message',
    role: 'user',
    content,
    reasoning: null,
    blocks: [],
    approval: null,
    isStreaming: false
  };
}

function buildLiveAssistantMessage(chatRunState: ChatRunState): ChatTranscriptMessage | null {
  const liveContent = chatRunState.assistantMessage;
  const liveBlocks = buildLiveActivityBlocks(chatRunState);
  const liveReasoning = readReasoningFromBlocks(liveBlocks);

  if (liveContent.length === 0 && liveBlocks.length === 0 && chatRunState.pendingApprovals.length === 0) {
    return null;
  }

  return {
    key: `live-${chatRunState.runId ?? 'assistant'}`,
    role: 'assistant',
    content: liveContent,
    reasoning: liveReasoning.length === 0 ? null : liveReasoning,
    blocks: liveBlocks,
    approval: chatRunState.pendingApprovals[0] ?? null,
    isStreaming: chatRunState.status === 'running'
  };
}

export function appendLiveTranscriptMessages(input: {
  chatRunState: ChatRunState;
  pendingUserInput: string | null;
  persistedMessages: ChatTranscriptMessage[];
  selectedThreadId: string | null;
}): ChatTranscriptMessage[] {
  const activeThreadId = resolveActiveThreadId(input.selectedThreadId, input.chatRunState);
  if (activeThreadId === null) {
    return input.pendingUserInput === null ? [] : [createPendingUserMessage(input.pendingUserInput)];
  }

  const messages = input.persistedMessages.slice();
  if (input.pendingUserInput !== null && !messages.some((message) => message.role === 'user' && message.content === input.pendingUserInput)) {
    messages.push(createPendingUserMessage(input.pendingUserInput));
  }

  if (input.chatRunState.threadId !== activeThreadId) {
    return messages;
  }

  const lastAssistantIndex = [...messages].reverse().findIndex((message) => message.role === 'assistant');
  const assistantIndex = lastAssistantIndex === -1 ? -1 : messages.length - 1 - lastAssistantIndex;
  if (assistantIndex !== -1) {
    const liveContent = input.chatRunState.assistantMessage;
    const liveBlocks = buildLiveActivityBlocks(input.chatRunState);
    const liveReasoning = readReasoningFromBlocks(liveBlocks);
    const matchesPersistedAssistant =
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
  }

  const liveMessage = buildLiveAssistantMessage(input.chatRunState);
  if (liveMessage !== null) {
    messages.push(liveMessage);
  }
  return messages;
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
    return input.pendingUserInput === null ? [] : [createPendingUserMessage(input.pendingUserInput)];
  }

  const persistedMessageEvents = input.persistedMessages ?? input.taskSnapshot.recentEvents;
  const messages = buildPersistedTranscriptMessages(persistedMessageEvents, activeThreadId);
  if (input.promotedThreadIds.has(activeThreadId) && input.chatRunState.threadId !== activeThreadId) {
    return messages;
  }

  return appendLiveTranscriptMessages({
    chatRunState: input.chatRunState,
    pendingUserInput: input.pendingUserInput,
    persistedMessages: messages,
    selectedThreadId: input.selectedThreadId
  });
}
