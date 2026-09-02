import type {
  ChatAssistantBlock,
  ChatPendingInterrupt,
  ChatPersistedAttachment,
  RocHookRunSummary,
  SubagentEventPayload,
  SubagentIdentity,
  SubagentStatus,
  TaskEvent
} from '../shared/types';
import {
  taskEventSchema,
  type GuardrailTaskEventPayload as GuardrailPayload,
  type MessageTaskEvent,
  type SubagentTaskEventPayload as SubagentEventRecord
} from '../shared/schemas/task-event';
import type { ChatRunActivityBlock, ChatRunState, ChatRunSubagentBlock, ChatRunSubagentNode } from './chat-run-state';
import { applyPendingInterruptProjection, readPersistedInterruptProjection } from './chat/interrupt-projection';

export type ChatTranscriptSubagentBlock =
  | {
      id: string;
      kind: 'text';
      content: string;
    }
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
    };

type ChatTranscriptSubagentActivityBlock = {
  id: string;
  kind: 'subagent';
  identity: SubagentIdentity;
  status: SubagentStatus;
  summary: string | null;
  error: string | null;
  blocks: ChatTranscriptSubagentBlock[];
  children: ChatTranscriptSubagentActivityBlock[];
};

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
      kind: 'hook_call';
      event: Extract<ChatRunActivityBlock, { kind: 'hook_call' }>['event'];
      handlerId: string;
      status: Extract<ChatRunActivityBlock, { kind: 'hook_call' }>['status'];
      durationMs: number | null;
      message: string | null;
      additionalContext: string | null;
      requestContinue: string | null;
      commandDisplay: string;
    }
  | ChatTranscriptSubagentActivityBlock
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
  source: 'persisted' | 'live';
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatPersistedAttachment[];
  reasoning: string | null;
  blocks: ChatTranscriptActivityBlock[];
  interrupts: ChatPendingInterrupt[];
  isStreaming: boolean;
};

type AssistantDraft = {
  message: ChatTranscriptMessage;
  reasoningBlock: Extract<ChatTranscriptActivityBlock, { kind: 'reasoning' }> | null;
  toolBlocks: Array<Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>>;
  hookBlocks: Array<Extract<ChatTranscriptActivityBlock, { kind: 'hook_call' }>>;
  subagentBlocks: Array<Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>>;
};

function compareTaskEventsAscending(left: TaskEvent, right: TaskEvent): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  return (left.sequence === undefined ? 0 : left.sequence) - (right.sequence === undefined ? 0 : right.sequence);
}

function createUserMessage(
  runId: string,
  occurrence: number,
  payload: Extract<MessageTaskEvent['payload'], { role: 'user' }>
): ChatTranscriptMessage {
  return {
    // 首条沿用 user-${runId}，与 createPendingUserMessage 的 live key 对齐，流式转持久化时不重挂载。
    // 同一 run 可以有多条用户消息（commitResumeDispatch 在 human_question_answered 时会往同 run 追加），
    // 后续条目加序号后缀保证 key 唯一。
    key: occurrence === 1 ? `user-${runId}` : `user-${runId}#${occurrence}`,
    source: 'persisted',
    role: 'user',
    content: payload.content,
    attachments: payload.attachments === undefined ? [] : payload.attachments,
    reasoning: null,
    blocks: [],
    interrupts: [],
    isStreaming: false
  };
}

function createAssistantDraft(runId: string): AssistantDraft {
  return {
    message: {
      key: `assistant-${runId}`,
      source: 'persisted',
      role: 'assistant',
      content: '',
      attachments: [],
      reasoning: null,
      blocks: [],
      interrupts: [],
      isStreaming: false
    },
    reasoningBlock: null,
    toolBlocks: [],
    hookBlocks: [],
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

function applyHookBlock(draft: AssistantDraft, hook: RocHookRunSummary): void {
  const existing = draft.hookBlocks.find((block) => block.id === hook.runId);
  const nextBlock: Extract<ChatTranscriptActivityBlock, { kind: 'hook_call' }> = {
    id: hook.runId,
    kind: 'hook_call',
    event: hook.event,
    handlerId: hook.handlerId,
    status: hook.status,
    durationMs: hook.durationMs,
    message: hook.message,
    additionalContext: hook.additionalContext,
    requestContinue: hook.requestContinue,
    commandDisplay: hook.commandDisplay
  };
  if (existing === undefined) {
    draft.hookBlocks.push(nextBlock);
    draft.message.blocks.push(nextBlock);
    return;
  }
  draft.hookBlocks = draft.hookBlocks.map((block) => (block === existing ? nextBlock : block));
  draft.message.blocks = draft.message.blocks.map((block) => (block === existing ? nextBlock : block));
}

function applyStructuredSubagentBlock(draft: AssistantDraft, payload: SubagentEventRecord): void {
  draft.subagentBlocks = upsertTranscriptSubagentBlock(
    draft.subagentBlocks,
    payload.identity.parentSubagentId,
    payload.identity,
    payload.event,
    false
  );
  syncDraftSubagentBlocks(draft);
}

function syncDraftSubagentBlocks(draft: AssistantDraft): void {
  const seen = new Set<string>();
  draft.message.blocks = draft.message.blocks.map((block) => {
    if (block.kind !== 'subagent') {
      return block;
    }
    seen.add(block.id);
    return draft.subagentBlocks.find((candidate) => candidate.id === block.id) ?? block;
  });
  for (const block of draft.subagentBlocks) {
    if (!seen.has(block.id)) {
      draft.message.blocks.push(block);
    }
  }
}

function filterSubagentTaskToolBlocks(blocks: ChatTranscriptSubagentBlock[]): ChatTranscriptSubagentBlock[] {
  const nextBlocks = blocks.filter((block) => block.kind !== 'tool_call' || block.name !== 'task');
  return nextBlocks.length === blocks.length ? blocks : nextBlocks;
}

function normalizeSubagentActivityBlock(block: ChatTranscriptSubagentActivityBlock): ChatTranscriptSubagentActivityBlock {
  const children = block.children.map((child) => normalizeSubagentActivityBlock(child));
  const hasChildChange = children.some((child, index) => child !== block.children[index]);
  const blocks = block.children.length === 0 ? block.blocks : filterSubagentTaskToolBlocks(block.blocks);
  if (!hasChildChange && blocks === block.blocks) {
    return block;
  }
  return {
    ...block,
    blocks,
    children
  };
}

function filterRedundantSubagentTaskBlocks(blocks: ChatTranscriptActivityBlock[]): ChatTranscriptActivityBlock[] {
  let changed = false;
  const normalizedBlocks = blocks.map((block) => {
    if (block.kind !== 'subagent') {
      return block;
    }
    const nextBlock = normalizeSubagentActivityBlock(block);
    if (nextBlock !== block) {
      changed = true;
    }
    return nextBlock;
  });
  if (!normalizedBlocks.some((block) => block.kind === 'subagent')) {
    return changed ? normalizedBlocks : blocks;
  }
  const nextBlocks = normalizedBlocks.filter((block) => block.kind !== 'tool_call' || block.name !== 'task');
  return changed || nextBlocks.length !== blocks.length ? nextBlocks : blocks;
}

function filterRedundantSubagentTaskBlocksFromMessage(message: ChatTranscriptMessage): ChatTranscriptMessage {
  const blocks = filterRedundantSubagentTaskBlocks(message.blocks);
  const content = stripHookDisplayText(message.content, blocks);
  return blocks === message.blocks && content === message.content
    ? message
    : {
        ...message,
        content,
        blocks
      };
}

function hookDisplayTexts(blocks: readonly ChatTranscriptActivityBlock[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'hook_call') {
      continue;
    }
    if (block.additionalContext !== null && block.additionalContext.length > 0 && !texts.includes(block.additionalContext)) {
      texts.push(block.additionalContext);
    }
    if (block.requestContinue !== null && block.requestContinue.length > 0 && !texts.includes(block.requestContinue)) {
      texts.push(block.requestContinue);
    }
  }
  return texts;
}

function stripHookDisplayText(content: string, blocks: readonly ChatTranscriptActivityBlock[]): string {
  let nextContent = content;
  for (const text of hookDisplayTexts(blocks).sort((left, right) => right.length - left.length)) {
    nextContent = nextContent.split(text).join('');
  }
  return nextContent === content ? content : nextContent.trimStart();
}

function upsertTranscriptSubagentBlock(
  blocks: readonly ChatTranscriptSubagentActivityBlock[],
  parentSubagentId: string | null,
  identity: SubagentIdentity,
  payload: SubagentEventPayload,
  isStreaming: boolean
): ChatTranscriptSubagentActivityBlock[] {
  if (parentSubagentId !== null) {
    return blocks.map((block) =>
      block.identity.subagentId === parentSubagentId
        ? {
            ...block,
            children: upsertTranscriptSubagentBlock(block.children, null, identity, payload, isStreaming)
          }
        : {
            ...block,
            children: upsertTranscriptSubagentBlock(block.children, parentSubagentId, identity, payload, isStreaming)
          }
    );
  }

  const existing = blocks.find((block) => block.identity.subagentId === identity.subagentId);
  const next = applyTranscriptSubagentEvent(
    existing ?? {
      id: identity.subagentId,
      kind: 'subagent',
      identity,
      status: 'started',
      summary: null,
      error: null,
      blocks: [],
      children: []
    },
    payload,
    isStreaming
  );
  return existing === undefined ? [...blocks, next] : blocks.map((block) => (block === existing ? next : block));
}

function applyTranscriptSubagentEvent(
  block: ChatTranscriptSubagentActivityBlock,
  payload: SubagentEventPayload,
  isStreaming: boolean
): ChatTranscriptSubagentActivityBlock {
  if (payload.kind === 'started') {
    return {
      ...block,
      status: 'started'
    };
  }
  if (payload.kind === 'assistant_block') {
    return {
      ...block,
      status: block.status === 'started' ? 'running' : block.status,
      blocks: appendTranscriptSubagentAssistantBlock(block.blocks, payload.block, isStreaming)
    };
  }
  if (payload.kind === 'tool_call') {
    return {
      ...block,
      status: block.status === 'started' ? 'running' : block.status,
      blocks: appendTranscriptSubagentToolBlock(block.blocks, payload.block)
    };
  }
  if (payload.kind === 'async_status') {
    return {
      ...block,
      status: 'running'
    };
  }
  if (payload.kind === 'completed') {
    return {
      ...block,
      status: 'completed',
      summary: payload.summary
    };
  }
  if (payload.kind === 'failed') {
    return {
      ...block,
      status: 'failed',
      error: payload.error
    };
  }
  return {
    ...block,
    status: 'cancelled',
    error: payload.reason ?? null
  };
}

function appendTranscriptSubagentAssistantBlock(
  blocks: readonly ChatTranscriptSubagentBlock[],
  block: ChatAssistantBlock,
  isStreaming: boolean
): ChatTranscriptSubagentBlock[] {
  if (block.kind === 'text') {
    if (typeof block.text !== 'string') {
      return [...blocks];
    }
    const existing = blocks.find((item): item is Extract<ChatTranscriptSubagentBlock, { kind: 'text' }> => item.kind === 'text' && item.id === block.blockId);
    if (existing === undefined) {
      return [...blocks, { id: block.blockId, kind: 'text', content: block.text }];
    }
    return blocks.map((item) => (item === existing ? { ...item, content: `${item.content}${block.text}` } : item));
  }
  if (block.kind === 'reasoning') {
    if (typeof block.text !== 'string') {
      return [...blocks];
    }
    const existing = blocks.find((item): item is Extract<ChatTranscriptSubagentBlock, { kind: 'reasoning' }> => item.kind === 'reasoning' && item.id === block.blockId);
    if (existing === undefined) {
      return [...blocks, { id: block.blockId, kind: 'reasoning', content: block.text, isStreaming }];
    }
    return blocks.map((item) =>
      item === existing ? { ...item, content: `${item.content}${block.text}`, isStreaming } : item
    );
  }
  return appendTranscriptSubagentToolBlock(blocks, block);
}

function appendTranscriptSubagentToolBlock(
  blocks: readonly ChatTranscriptSubagentBlock[],
  payload: Extract<ChatAssistantBlock, { kind: 'tool_call' }>
): ChatTranscriptSubagentBlock[] {
  const existing = blocks.find((block): block is Extract<ChatTranscriptSubagentBlock, { kind: 'tool_call' }> => block.kind === 'tool_call' && block.id === payload.blockId);
  const nextBlock: Extract<ChatTranscriptSubagentBlock, { kind: 'tool_call' }> = {
    id: payload.blockId,
    kind: 'tool_call',
    name: payload.name,
    status: payload.phase,
    input: existing === undefined ? null : existing.input,
    output: existing === undefined ? null : existing.output,
    error: existing === undefined ? null : existing.error
  };
  if ('input' in payload) {
    nextBlock.input = payload.input;
  }
  if ('output' in payload) {
    nextBlock.output = payload.output;
  }
  if ('error' in payload) {
    nextBlock.error = payload.error;
  }
  if (existing === undefined) {
    return [...blocks, nextBlock];
  }
  return blocks.map((block) => (block === existing ? nextBlock : block));
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
  const userOccurrences = new Map<string, number>();

  for (const candidate of recentEvents
    .filter((candidate) => candidate.threadId === threadId)
    .slice()
    .sort(compareTaskEventsAscending)) {
    const parsedEvent = taskEventSchema.safeParse(candidate);
    if (!parsedEvent.success) {
      continue;
    }
    const event = parsedEvent.data;
    if (event.type === 'message') {
      if (event.payload.role === 'user') {
        const occurrence = (userOccurrences.get(event.runId) ?? 0) + 1;
        userOccurrences.set(event.runId, occurrence);
        messages.push(createUserMessage(event.runId, occurrence, event.payload));
        continue;
      }

      const draft = getAssistantDraft(drafts, messages, event.runId);
      draft.message.content = event.payload.content;
      continue;
    }

    if (event.type === 'assistant_block') {
      applyAssistantBlock(getAssistantDraft(drafts, messages, event.runId), event.payload, false);
      continue;
    }

    if (event.type === 'hook_started' || event.type === 'hook_completed') {
      applyHookBlock(getAssistantDraft(drafts, messages, event.runId), event.payload);
      continue;
    }

    if (event.type === 'subagent_event') {
      applyStructuredSubagentBlock(getAssistantDraft(drafts, messages, event.runId), event.payload);
      continue;
    }

    if (event.type === 'guardrail_nudge') {
      appendGuardrailBlock(getAssistantDraft(drafts, messages, event.runId), event.payload, `guardrail-${event.runId}`);
      continue;
    }

    const interruptProjection = readPersistedInterruptProjection(event);
    if (interruptProjection !== null) {
      const draft = getAssistantDraft(drafts, messages, event.runId);
      draft.message.interrupts = applyPendingInterruptProjection(draft.message.interrupts, interruptProjection);
      continue;
    }
  }

  const transcript = messages
    .map((message) => (message.role === 'assistant' ? filterRedundantSubagentTaskBlocksFromMessage(message) : message))
    .filter(
      (message) => message.role === 'user' || message.content.length > 0 || message.blocks.length > 0 || message.interrupts.length > 0
    );
  assertUniqueTranscriptKeys(transcript);
  return transcript;
}

function buildLiveActivityBlocks(chatRunState: ChatRunState): ChatTranscriptActivityBlock[] {
  const blocks: ChatTranscriptActivityBlock[] = chatRunState.activityBlocks.map((block) => {
    if (block.kind === 'reasoning') {
      return {
        id: block.id,
        kind: 'reasoning',
        content: block.content,
        isStreaming: chatRunState.status === 'running'
      };
    }
    if (block.kind === 'hook_call') {
      return {
        id: block.id,
        kind: 'hook_call',
        event: block.event,
        handlerId: block.handlerId,
        status: block.status,
        durationMs: block.durationMs,
        message: block.message,
        additionalContext: block.additionalContext,
        requestContinue: block.requestContinue,
        commandDisplay: block.commandDisplay
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
  blocks.push(...chatRunState.subagents.map((subagent) => mapLiveSubagentNode(subagent, chatRunState.status === 'running')));
  return filterRedundantSubagentTaskBlocks(blocks);
}

function mapLiveSubagentNode(node: ChatRunSubagentNode, isStreaming: boolean): ChatTranscriptSubagentActivityBlock {
  return {
    id: node.identity.subagentId,
    kind: 'subagent',
    identity: node.identity,
    status: node.status,
    summary: node.summary,
    error: node.error,
    blocks: node.blocks.map((block) => mapLiveSubagentBlock(block, isStreaming)),
    children: node.children.map((child) => mapLiveSubagentNode(child, isStreaming))
  };
}

function mapLiveSubagentBlock(block: ChatRunSubagentBlock, isStreaming: boolean): ChatTranscriptSubagentBlock {
  if (block.kind === 'text') {
    return block;
  }
  if (block.kind === 'reasoning') {
    return {
      ...block,
      isStreaming
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
}

function readReasoningFromBlocks(blocks: readonly ChatTranscriptActivityBlock[]): string {
  return blocks.flatMap((block) => (block.kind === 'reasoning' ? [block.content] : [])).join('');
}

function createPendingUserMessage(content: string, runId: string | null): ChatTranscriptMessage {
  return {
    key: runId === null ? 'pending-user-message' : `user-${runId}`,
    source: 'live',
    role: 'user',
    content,
    attachments: [],
    reasoning: null,
    blocks: [],
    interrupts: [],
    isStreaming: false
  };
}

function buildLiveAssistantMessage(chatRunState: ChatRunState): ChatTranscriptMessage | null {
  const liveBlocks = buildLiveActivityBlocks(chatRunState);
  const liveContent = stripHookDisplayText(chatRunState.assistantMessage, liveBlocks);
  const liveReasoning = readReasoningFromBlocks(liveBlocks);

  if (liveContent.length === 0 && liveBlocks.length === 0 && chatRunState.pendingInterrupts.length === 0) {
    return null;
  }

  return {
    key: chatRunState.runId === null ? 'live-assistant' : `assistant-${chatRunState.runId}`,
    source: 'live',
    role: 'assistant',
    content: liveContent,
    attachments: [],
    reasoning: liveReasoning.length === 0 ? null : liveReasoning,
    blocks: liveBlocks,
    interrupts: chatRunState.pendingInterrupts,
    isStreaming: chatRunState.status === 'running'
  };
}

function appendLiveTranscriptMessages(input: {
  activeThreadId: string;
  chatRunState: ChatRunState;
  pendingUserInput: string | null;
  persistedMessages: ChatTranscriptMessage[];
  selectedThreadId: string | null;
}): ChatTranscriptMessage[] {
  assertUniqueTranscriptKeys(input.persistedMessages);
  const activeThreadId = input.activeThreadId;
  const messages = input.persistedMessages.slice();
  const pendingUserInput = input.pendingUserInput;
  const shouldProjectPendingUser = pendingUserInput !== null &&
    (input.selectedThreadId === null || input.chatRunState.threadId === activeThreadId);
  if (shouldProjectPendingUser && pendingUserInput !== null) {
    const pendingUserMessage = createPendingUserMessage(pendingUserInput, input.chatRunState.runId);
    const existingPendingUser = messages.find((message) => message.key === pendingUserMessage.key);
    if (existingPendingUser !== undefined && existingPendingUser.role !== 'user') {
      throw new Error(`chat_transcript_identity_role_conflict:${pendingUserMessage.key}`);
    }
    if (existingPendingUser === undefined) {
      messages.push(pendingUserMessage);
    }
  }

  if (input.chatRunState.threadId !== activeThreadId) {
    assertUniqueTranscriptKeys(messages);
    return messages;
  }

  const liveMessage = buildLiveAssistantMessage(input.chatRunState);
  if (liveMessage === null) {
    assertUniqueTranscriptKeys(messages);
    return messages;
  }

  const existingIndex = messages.findIndex((message) => message.key === liveMessage.key);
  if (existingIndex === -1) {
    messages.push(liveMessage);
    assertUniqueTranscriptKeys(messages);
    return messages;
  }

  const existingMessage = messages[existingIndex];
  if (existingMessage.role !== 'assistant') {
    throw new Error(`chat_transcript_identity_role_conflict:${liveMessage.key}`);
  }
  messages[existingIndex] = {
    ...existingMessage,
    content: liveMessage.content.length === 0 ? existingMessage.content : liveMessage.content,
    reasoning: liveMessage.reasoning === null ? existingMessage.reasoning : liveMessage.reasoning,
    blocks: liveMessage.blocks.length === 0 ? existingMessage.blocks : liveMessage.blocks,
    interrupts: liveMessage.interrupts,
    isStreaming: liveMessage.isStreaming
  };
  assertUniqueTranscriptKeys(messages);
  return messages;
}

function assertUniqueTranscriptKeys(messages: readonly ChatTranscriptMessage[]): void {
  const keys = new Set<string>();
  for (const message of messages) {
    if (keys.has(message.key)) {
      throw new Error(`chat_transcript_duplicate_key:${message.key}`);
    }
    keys.add(message.key);
  }
}

export function projectChatTranscript(input: {
  events: TaskEvent[];
  liveRun: ChatRunState | null;
  pendingUserInput: string | null;
  threadId: string | null;
}): ChatTranscriptMessage[] {
  const activeThreadId = input.threadId ?? input.liveRun?.threadId ?? null;
  if (activeThreadId === null) {
    const messages = input.pendingUserInput === null
      ? []
      : [createPendingUserMessage(input.pendingUserInput, input.liveRun?.runId ?? null)];
    assertUniqueTranscriptKeys(messages);
    return messages;
  }

  const persistedMessages = buildPersistedTranscriptMessages(input.events, activeThreadId);
  if (input.liveRun === null) {
    return persistedMessages;
  }

  return appendLiveTranscriptMessages({
    activeThreadId,
    chatRunState: input.liveRun,
    pendingUserInput: input.pendingUserInput,
    persistedMessages,
    selectedThreadId: input.threadId
  });
}

/**
 * 投影只读 run 状态的这几个字段，所以 memo 键由本模块给出，而不是让调用方手列。
 * 新增字段忘列会静默不更新，故这份清单必须与 `appendLiveTranscriptMessages` 实际读取保持一致。
 */
export function readChatTranscriptMemoKey(input: {
  events: TaskEvent[];
  liveRun: ChatRunState | null;
  pendingUserInput: string | null;
  threadId: string | null;
}): readonly unknown[] {
  const liveRun = input.liveRun;
  return [
    input.events,
    liveRun === null ? null : liveRun.activityBlocks,
    liveRun === null ? null : liveRun.assistantMessage,
    liveRun === null ? null : liveRun.pendingInterrupts,
    liveRun === null ? null : liveRun.runId,
    liveRun === null ? null : liveRun.status,
    liveRun === null ? null : liveRun.subagents,
    liveRun === null ? null : liveRun.threadId,
    input.pendingUserInput,
    input.threadId
  ];
}
