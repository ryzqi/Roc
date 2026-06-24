import type {
  ChatAssistantBlock,
  ChatPendingApproval,
  ChatPersistedAttachment,
  SubagentEventPayload,
  SubagentIdentity,
  SubagentStatus,
  TaskEvent,
  TaskSnapshot
} from '../shared/types';
import type { ChatRunActivityBlock, ChatRunState, ChatRunSubagentBlock, ChatRunSubagentNode } from './chat-run-state';

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

export type ChatTranscriptSubagentActivityBlock = {
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
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatPersistedAttachment[];
  reasoning: string | null;
  blocks: ChatTranscriptActivityBlock[];
  approval: ChatPendingApproval | null;
  isStreaming: boolean;
};

type MessagePayload = {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatPersistedAttachment[];
};

type SubagentEventRecord = {
  sequence: number;
  identity: SubagentIdentity;
  event: SubagentEventPayload;
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
  const attachments = Reflect.get(payload, 'attachments');
  return (
    (role === 'user' || role === 'assistant') &&
    typeof content === 'string' &&
    (attachments === undefined || (Array.isArray(attachments) && attachments.every(isPersistedAttachment)))
  );
}

function isPersistedAttachment(value: unknown): value is ChatPersistedAttachment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = Reflect.get(value, 'kind');
  const name = Reflect.get(value, 'name');
  const mediaType = Reflect.get(value, 'mediaType');
  const sizeBytes = Reflect.get(value, 'sizeBytes');
  return (
    kind === 'image' &&
    typeof name === 'string' &&
    (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp') &&
    typeof sizeBytes === 'number'
  );
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

function isSubagentEventRecord(payload: unknown): payload is SubagentEventRecord {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const sequence = Reflect.get(payload, 'sequence');
  const identity = Reflect.get(payload, 'identity');
  const event = Reflect.get(payload, 'event');
  return typeof sequence === 'number' && isSubagentIdentity(identity) && isSubagentEventPayload(event);
}

function isSubagentIdentity(value: unknown): value is SubagentIdentity {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const subagentId = Reflect.get(value, 'subagentId');
  const parentSubagentId = Reflect.get(value, 'parentSubagentId');
  const name = Reflect.get(value, 'name');
  const depth = Reflect.get(value, 'depth');
  const path = Reflect.get(value, 'path');
  const execution = Reflect.get(value, 'execution');
  const taskInput = Reflect.get(value, 'taskInput');
  const asyncTaskId = Reflect.get(value, 'asyncTaskId');
  return (
    typeof subagentId === 'string' &&
    (parentSubagentId === null || typeof parentSubagentId === 'string') &&
    typeof name === 'string' &&
    typeof depth === 'number' &&
    Array.isArray(path) &&
    path.every((item) => typeof item === 'string') &&
    (execution === 'sync' || execution === 'async') &&
    (taskInput === null || typeof taskInput === 'string') &&
    (asyncTaskId === undefined || typeof asyncTaskId === 'string')
  );
}

function isSubagentEventPayload(value: unknown): value is SubagentEventPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = Reflect.get(value, 'kind');
  if (kind === 'started') {
    return true;
  }
  if (kind === 'assistant_block') {
    return isAssistantBlockPayload(Reflect.get(value, 'block'));
  }
  if (kind === 'tool_call') {
    const block = Reflect.get(value, 'block');
    return isAssistantBlockPayload(block) && Reflect.get(block, 'kind') === 'tool_call';
  }
  if (kind === 'async_status') {
    return typeof Reflect.get(value, 'status') === 'string';
  }
  if (kind === 'completed') {
    const summary = Reflect.get(value, 'summary');
    return summary === null || typeof summary === 'string';
  }
  if (kind === 'failed') {
    return typeof Reflect.get(value, 'error') === 'string';
  }
  if (kind === 'cancelled') {
    const reason = Reflect.get(value, 'reason');
    return reason === undefined || typeof reason === 'string';
  }
  return false;
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
    attachments: event.payload.attachments === undefined ? [] : event.payload.attachments,
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
      attachments: [],
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
  return blocks === message.blocks
    ? message
    : {
        ...message,
        blocks
      };
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

    if (event.type === 'subagent_event' && isSubagentEventRecord(event.payload)) {
      applyStructuredSubagentBlock(getAssistantDraft(drafts, messages, event.runId), event.payload);
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

  return messages
    .map((message) => (message.role === 'assistant' ? filterRedundantSubagentTaskBlocksFromMessage(message) : message))
    .filter(
      (message) => message.role === 'user' || message.content.length > 0 || message.blocks.length > 0 || message.approval !== null
    );
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

function createPendingUserMessage(content: string): ChatTranscriptMessage {
  return {
    key: 'pending-user-message',
    role: 'user',
    content,
    attachments: [],
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
    attachments: [],
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
