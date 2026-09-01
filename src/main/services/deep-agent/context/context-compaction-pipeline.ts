import { AIMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';

import type { RunExecutionSnapshotV2 } from '../../../../shared/types';

import { classifyProviderRequestFailure, isRetryableProviderHttpStatus } from '../../provider-request-retry';
import {
  createForgeTieredCompactionEdits,
  type ForgeTieredCompactionOptions
} from '../../forge-guardrails/middleware/forge-tiered-compaction';
import { readIterationFromMessage } from '../../forge-guardrails/state-schema';
import { isContextDigestMessage } from '../../forge-guardrails/context-digest';
import {
  ContextArtifactStore,
  formatContextArtifactLocator,
  formatContextArtifactReference,
  type PersistedContextArtifact
} from './context-artifact-store';
import {
  buildContextSummaryModelMessages,
  contextSummarySchema,
  contextSummaryToDigestMessage,
  summarizeWithCurrentModel,
  type ContextSummary,
  type ContextSummaryInput
} from './context-summary';
import {
  createContextTokenCounter,
  deriveContextBudgetProfile,
  type ContextBudgetProfile,
  type ContextTokenCounter
} from './context-token-budget';

const DEFAULT_TOOL_RESULT_PERSIST_CHARS = 30_000;
const SUMMARY_THRESHOLD = 0.9;
const SUMMARY_RECENT_ITERATIONS = 2;
const SUMMARY_RECENT_FALLBACK_MESSAGES = 6;

export type ContextCompactionMode = RunExecutionSnapshotV2['mode'];

export type ContextMaintenanceStage = 'persist' | 'deterministic' | 'summary';

export type ContextMaintenanceEvent = {
  type:
    | 'context_compaction_started'
    | 'context_tool_result_persisted'
    | 'context_deterministic_compacted'
    | 'context_summary_started'
    | 'context_summary_completed'
    | 'context_summary_skipped'
    | 'context_compaction_failed';
  runId: string;
  threadId: string;
  mode: ContextCompactionMode;
  stage: ContextMaintenanceStage;
  persistedChars?: number;
  removedChars?: number;
  inputTokens?: number;
  budgetTokens?: number;
  estimated?: boolean;
};

/**
 * 压缩摘要要作为一条会话消息落进历史。这里只声明"记一次压缩前 flush"这个意图，
 * 由 session 历史的拥有者（AgentSessionRepository）决定它落在哪个 phase、是否对渲染层可见。
 */
export type PreCompactionFlushRecorder = {
  recordPreCompactionFlush(input: {
    content: string;
    threadId: string;
    tokenCount: number;
    workspaceHash: string | null;
  }): void;
};

export type RocContextCompactionOptions = {
  artifactStore: ContextArtifactStore;
  artifactRecoveryEnabled?: boolean;
  budgetProfile: ContextBudgetProfile;
  emitEvent: (event: ContextMaintenanceEvent) => void;
  mode: ContextCompactionMode;
  model: Pick<BaseChatModel, 'invoke'> & Partial<Pick<BaseChatModel, 'getNumTokens'>>;
  runId: string;
  sessionHistory: PreCompactionFlushRecorder;
  threadId: string;
  tokenCounter?: ContextTokenCounter;
  toolResultPersistChars?: number;
  workspaceHash: string | null;
  workspacePath: string | null;
};

/**
 * 压缩过程不改调用方的数组：每个阶段收 readonly 消息、返回新数组，由 runContextCompaction 串起来。
 * 唯一的例外圈在 runDeterministicCompaction 内部 —— langchain 的 ContextEdit.apply 契约是原地改。
 */
type RunCompactionInput = RocContextCompactionOptions & {
  countTokens: (messages: readonly BaseMessage[]) => Promise<number>;
  countTokensEstimated?: () => boolean;
  messages: readonly BaseMessage[];
  summarize?: (input: ContextSummaryInput) => Promise<ContextSummary>;
};

type ToolPairSnapshot = {
  aiMessage: AIMessage;
  toolMessage: ToolMessage;
};

export function createRocContextCompactionMiddleware(options: RocContextCompactionOptions) {
  const tokenCounter = options.tokenCounter === undefined
    ? createContextTokenCounter(options.model as Pick<BaseChatModel, 'getNumTokens'>)
    : options.tokenCounter;
  return createMiddleware({
    name: 'RocContextCompactionPipeline',
    beforeModel: async (state) => {
      const originalMessages = state.messages;
      let estimated = false;
      const compactedMessages = await runContextCompaction({
        ...options,
        tokenCounter,
        messages: originalMessages,
        countTokens: async (messages) => {
          const count = await tokenCounter.countMessages(messages);
          estimated ||= count.estimated;
          return count.tokens;
        },
        countTokensEstimated: () => estimated || tokenCounter.wasEstimated(),
        summarize: async (input) => await summarizeWithCurrentModel({ ...input, model: options.model })
      });
      if (sameMessageSequence(originalMessages, compactedMessages)) {
        return undefined;
      }
      return {
        messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...compactedMessages]
      };
    },
    wrapModelCall: async (request, handler) => {
      const tools = request.tools.map((tool) => {
        const name = Reflect.get(tool, 'name');
        const description = Reflect.get(tool, 'description');
        if (typeof name !== 'string') {
          throw new Error('agent_tool_name_missing');
        }
        if (typeof description !== 'string') {
          throw new Error(`agent_tool_description_missing:${name}`);
        }
        return {
          name,
          description,
          schema: Reflect.get(tool, 'schema')
        };
      });
      const profile = await deriveContextBudgetProfile({
        contextWindowTokens: options.budgetProfile.contextWindowTokens,
        counter: tokenCounter,
        systemPrompt: contentToString(request.systemMessage.content),
        tools
      });
      const count = await tokenCounter.countMessages(request.messages);
      if (count.tokens > profile.modelInputTokens) {
        throw new Error('context_budget_exhausted');
      }
      return await handler(request);
    }
  });
}

export async function runContextCompaction(input: RunCompactionInput): Promise<BaseMessage[]> {
  let stage: ContextMaintenanceStage = 'persist';
  try {
    input.emitEvent(createEvent(input, 'context_compaction_started', stage));
    const persisted = persistLargeToolResults(input);
    const artifacts = persisted.artifacts;
    const beforeDeterministicMessages = persisted.messages;
    const toolPairs = snapshotToolPairs(beforeDeterministicMessages);
    const beforeDeterministicChars = measureMessages(beforeDeterministicMessages);

    stage = 'deterministic';
    let messages = restoreIncompleteToolPairs(
      await runDeterministicCompaction(input, beforeDeterministicMessages),
      toolPairs
    );
    const afterDeterministicChars = measureMessages(messages);
    const deterministicTokens = await input.countTokens(messages);
    input.emitEvent({
      ...createEvent(input, 'context_deterministic_compacted', stage),
      removedChars: Math.max(0, beforeDeterministicChars - afterDeterministicChars),
      inputTokens: deterministicTokens,
      budgetTokens: input.budgetProfile.modelInputTokens,
      estimated: input.countTokensEstimated?.() === true
    });

    const tokensAfterDeterministic = deterministicTokens;
    if (tokensAfterDeterministic < input.budgetProfile.modelInputTokens * SUMMARY_THRESHOLD) {
      input.emitEvent(createEvent(input, 'context_summary_skipped', 'summary'));
      return messages;
    }

    stage = 'summary';
    input.emitEvent(createEvent(input, 'context_summary_started', stage));
    const preparedSummary = await prepareSummaryInput(
      input,
      artifacts,
      selectMessagesToSummarize(messages),
      beforeDeterministicMessages
    );
    if (preparedSummary.summaryInput === null) {
      messages = compactToArtifactReferenceTail(messages, preparedSummary.artifactLocators);
      messages = await enforceHardContextLimit(input, messages);
      input.emitEvent(createEvent(input, 'context_compaction_failed', 'summary'));
      return messages;
    }
    const summary = await summarizeContextOrSkip(input, preparedSummary.summaryInput);
    if (summary === null) {
      messages = compactToArtifactReferenceTail(messages, preparedSummary.artifactLocators);
      messages = await enforceHardContextLimit(input, messages);
      input.emitEvent(createEvent(input, 'context_compaction_failed', 'summary'));
      return messages;
    }
    const digestMessage = contextSummaryToDigestMessage({
      ...summary,
      toolEvidence: [...new Set([...summary.toolEvidence, ...preparedSummary.artifactLocators])]
    });
    messages = compactToSummaryTail(messages, digestMessage);
    input.sessionHistory.recordPreCompactionFlush({
      content: digestMessage.content.toString(),
      threadId: input.threadId,
      tokenCount: await input.countTokens([digestMessage]),
      workspaceHash: input.workspaceHash
    });
    messages = await enforceHardContextLimit(input, messages);
    input.emitEvent({
      ...createEvent(input, 'context_summary_completed', stage),
      inputTokens: await input.countTokens(messages),
      budgetTokens: input.budgetProfile.modelInputTokens,
      estimated: input.countTokensEstimated?.() === true
    });
    return messages;
  } catch (error) {
    input.emitEvent(createEvent(input, 'context_compaction_failed', stage));
    throw error;
  }
}

async function summarizeContextOrSkip(
  input: RunCompactionInput,
  summaryInput: ContextSummaryInput
): Promise<ContextSummary | null> {
  try {
    return await summarizeContext(input, summaryInput);
  } catch (error) {
    if (isRecoverableSummaryFailure(error)) {
      return null;
    }
    throw error;
  }
}

function persistLargeToolResults(
  input: RunCompactionInput
): { artifacts: PersistedContextArtifact[]; messages: BaseMessage[] } {
  const artifacts: PersistedContextArtifact[] = [];
  const messages = [...input.messages];
  if (input.artifactRecoveryEnabled === false) {
    return { artifacts, messages };
  }
  const threshold =
    input.toolResultPersistChars === undefined ? DEFAULT_TOOL_RESULT_PERSIST_CHARS : input.toolResultPersistChars;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (!ToolMessage.isInstance(message)) {
      continue;
    }
    if (typeof message.content !== 'string' || message.content.length <= threshold) {
      continue;
    }

    const artifact = input.artifactStore.persistArtifact({
      content: message.content,
      kind: 'tool_result',
      runId: input.runId,
      threadId: input.threadId,
      toolCallId: message.tool_call_id,
      toolName: message.name,
      workspaceHash: input.workspaceHash
    });
    const reference = formatContextArtifactReference(artifact);
    artifacts.push(artifact);
    messages[index] = new ToolMessage({
      id: message.id,
      tool_call_id: message.tool_call_id,
      name: message.name,
      content: reference,
      status: message.status,
      artifact: message.artifact,
      additional_kwargs: message.additional_kwargs,
      response_metadata: {
        ...message.response_metadata,
        roc_context_artifact: {
          artifactId: artifact.artifactId,
          sha256: artifact.sha256
        }
      },
      metadata: message.metadata
    });
    input.emitEvent({
      ...createEvent(input, 'context_tool_result_persisted', 'persist'),
      persistedChars: artifact.originalChars
    });
  }
  return { artifacts, messages };
}

// langchain 的 ContextEdit.apply 原地改数组，可变性只圈在这里：收 readonly，内部拷贝，返回新数组。
async function runDeterministicCompaction(
  input: RunCompactionInput,
  messages: readonly BaseMessage[]
): Promise<BaseMessage[]> {
  const options: ForgeTieredCompactionOptions = {
    budgetTokens: input.budgetProfile.modelInputTokens
  };
  const working = [...messages];
  const edits = createForgeTieredCompactionEdits(options);
  for (const edit of edits) {
    await edit.apply({
      messages: working,
      countTokens: input.countTokens
    });
  }
  return working;
}

function snapshotToolPairs(messages: readonly BaseMessage[]): ToolPairSnapshot[] {
  const toolResults = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (ToolMessage.isInstance(message)) {
      toolResults.set(message.tool_call_id, message);
    }
  }

  const pairs: ToolPairSnapshot[] = [];
  for (const message of messages) {
    if (!AIMessage.isInstance(message) || message.tool_calls === undefined) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      if (toolCall.id === undefined) {
        continue;
      }
      const toolResult = toolResults.get(toolCall.id);
      if (toolResult === undefined) {
        continue;
      }
      pairs.push({
        aiMessage: message,
        toolMessage: toolResult
      });
    }
  }
  return pairs;
}

function restoreIncompleteToolPairs(
  messages: readonly BaseMessage[],
  pairs: readonly ToolPairSnapshot[]
): BaseMessage[] {
  const restored = [...messages];
  for (const pair of pairs) {
    const aiIndex = restored.findIndex((message) => message === pair.aiMessage);
    const toolIndex = restored.findIndex(
      (message) => ToolMessage.isInstance(message) && message.tool_call_id === pair.toolMessage.tool_call_id
    );
    if (aiIndex >= 0 && toolIndex === -1) {
      restored.splice(aiIndex + 1, 0, pair.toolMessage);
      continue;
    }
    if (toolIndex >= 0 && restored[toolIndex] !== pair.toolMessage) {
      restored[toolIndex] = pair.toolMessage;
    }
    if (aiIndex === -1 && toolIndex >= 0) {
      restored.splice(toolIndex, 0, pair.aiMessage);
    }
  }
  return restored;
}

async function summarizeContext(
  input: RunCompactionInput,
  summaryInput: ContextSummaryInput
): Promise<ContextSummary> {
  const summarize =
    input.summarize === undefined
      ? async (summaryInput: ContextSummaryInput) => await summarizeWithCurrentModel({ ...summaryInput, model: input.model })
      : input.summarize;
  return await summarize(summaryInput);
}

async function prepareSummaryInput(
  input: RunCompactionInput,
  artifacts: readonly PersistedContextArtifact[],
  messagesToSummarize: readonly BaseMessage[],
  allMessages: readonly BaseMessage[]
): Promise<{ artifactLocators: string[]; summaryInput: ContextSummaryInput | null }> {
  const workingMessages = [...messagesToSummarize];
  const references = artifacts.map(formatContextArtifactReference);
  const artifactLocators = artifacts.map(formatContextArtifactLocator);
  let summaryInput = createSummaryInput(input, references, workingMessages, allMessages);
  if (await countSummaryInput(input, summaryInput) <= input.budgetProfile.summaryInputTokens) {
    return { artifactLocators, summaryInput };
  }

  if (workingMessages.length > 0 && input.artifactRecoveryEnabled !== false) {
    const artifact = input.artifactStore.persistArtifact({
      content: serializeMessages(workingMessages),
      kind: 'transcript',
      runId: input.runId,
      threadId: input.threadId,
      workspaceHash: input.workspaceHash
    });
    references.push(formatContextArtifactReference(artifact));
    artifactLocators.push(formatContextArtifactLocator(artifact));
  }

  while (workingMessages.length > 0) {
    removeMessageGroup(workingMessages, 0);
    summaryInput = createSummaryInput(input, references, workingMessages, allMessages);
    if (await countSummaryInput(input, summaryInput) <= input.budgetProfile.summaryInputTokens) {
      return { artifactLocators, summaryInput };
    }
  }
  return { artifactLocators, summaryInput: null };
}

function createSummaryInput(
  input: RunCompactionInput,
  artifactReferences: readonly string[],
  messages: readonly BaseMessage[],
  allMessages: readonly BaseMessage[]
): ContextSummaryInput {
  return {
    artifactReferences,
    goal: inferGoal(allMessages),
    messages,
    recentMessages: [],
    userConstraints: inferUserConstraints(messages),
    workspacePath: input.workspacePath
  };
}

async function countSummaryInput(input: RunCompactionInput, summaryInput: ContextSummaryInput): Promise<number> {
  const messageTokens = await input.countTokens(buildContextSummaryModelMessages(summaryInput));
  if (input.tokenCounter === undefined) {
    return messageTokens;
  }
  const schema = Reflect.get(contextSummarySchema, 'toJSONSchema');
  if (typeof schema !== 'function') {
    throw new Error('context_summary_schema_serializer_missing');
  }
  const schemaText = JSON.stringify(schema.call(contextSummarySchema));
  if (schemaText === undefined) {
    throw new Error('context_summary_schema_unserializable');
  }
  const schemaCount = await input.tokenCounter.countText(schemaText);
  return messageTokens + schemaCount.tokens;
}

function isRecoverableSummaryFailure(error: unknown): boolean {
  if (error instanceof Error && (error.message === 'context_summary_failed' || error.message === 'context_summary_invalid')) {
    return true;
  }
  const classification = classifyProviderRequestFailure(error);
  if (classification.kind === 'http') {
    return isRetryableProviderHttpStatus(classification.status);
  }
  return classification.kind === 'timeout' || classification.kind === 'network' || classification.kind === 'empty_response';
}

function selectMessagesToSummarize(messages: readonly BaseMessage[]): BaseMessage[] {
  const protectedMessages = new Set([
    ...selectProtectedHead(messages),
    ...selectRecentSummaryTail(messages)
  ]);
  return messages.filter((message) => !protectedMessages.has(message) && !isContextDigestMessage(message));
}

async function enforceHardContextLimit(
  input: RunCompactionInput,
  messages: readonly BaseMessage[]
): Promise<BaseMessage[]> {
  const initialTokens = await input.countTokens(messages);
  if (initialTokens <= input.budgetProfile.modelInputTokens) {
    return [...messages];
  }

  const protectedMessages = selectProtectedHead(messages);
  const latestDigest = [...messages].reverse().find(isContextDigestMessage);
  if (latestDigest !== undefined && !protectedMessages.includes(latestDigest)) {
    protectedMessages.push(latestDigest);
  }
  const protectedSet = new Set(protectedMessages);
  const compacted = messages.filter(
    (message) => protectedSet.has(message) || !isContextDigestMessage(message)
  );
  let tokens = await input.countTokens(compacted);
  while (tokens > input.budgetProfile.modelInputTokens) {
    const removableIndex = compacted.findIndex((message) => !protectedSet.has(message));
    if (removableIndex === -1) {
      break;
    }
    removeMessageGroup(compacted, removableIndex);
    tokens = await input.countTokens(compacted);
  }

  if (tokens > input.budgetProfile.modelInputTokens) {
    throw new Error('context_budget_exhausted');
  }
  return compacted;
}

function removeMessageGroup(messages: BaseMessage[], index: number): void {
  const message = messages[index];
  if (message === undefined) {
    return;
  }
  if (AIMessage.isInstance(message) && message.tool_calls !== undefined) {
    const toolCallIds = new Set(
      message.tool_calls
        .map((toolCall) => toolCall.id)
        .filter((id): id is string => typeof id === 'string')
    );
    for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
      if (cursor === index) {
        continue;
      }
      const candidate = messages[cursor];
      if (ToolMessage.isInstance(candidate) && toolCallIds.has(candidate.tool_call_id)) {
        messages.splice(cursor, 1);
      }
    }
  } else if (ToolMessage.isInstance(message)) {
    const pairIndex = messages.findIndex(
      (candidate) =>
        AIMessage.isInstance(candidate) &&
        candidate.tool_calls?.some((toolCall) => toolCall.id === message.tool_call_id)
    );
    if (pairIndex >= 0) {
      removeMessageGroup(messages, pairIndex);
      return;
    }
  }
  messages.splice(index, 1);
}

function sameMessageSequence(left: readonly BaseMessage[], right: readonly BaseMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function compactToSummaryTail(messages: readonly BaseMessage[], digestMessage: AIMessage): BaseMessage[] {
  const head = selectProtectedPrefix(messages);
  const tail = selectRecentSummaryTail(messages);
  return [
    ...head,
    digestMessage,
    ...tail.filter((message) => !head.includes(message) && !isContextDigestMessage(message))
  ];
}

function compactToArtifactReferenceTail(
  messages: readonly BaseMessage[],
  artifactLocators: readonly string[]
): BaseMessage[] {
  if (artifactLocators.length === 0) {
    return [...messages];
  }
  return compactToSummaryTail(messages, contextSummaryToDigestMessage({
    goal: inferGoal(messages),
    facts: [],
    decisions: [],
    filesTouched: [],
    toolEvidence: [...artifactLocators],
    verification: [],
    openQuestions: [],
    nextActions: []
  }));
}

function selectProtectedHead(messages: readonly BaseMessage[]): BaseMessage[] {
  const protectedMessages = selectProtectedPrefix(messages);
  const latestHuman = [...messages].reverse().find((message) => message.getType() === 'human');
  if (latestHuman !== undefined && !protectedMessages.includes(latestHuman)) {
    protectedMessages.push(latestHuman);
  }
  return protectedMessages;
}

function selectProtectedPrefix(messages: readonly BaseMessage[]): BaseMessage[] {
  const protectedMessages: BaseMessage[] = [];
  const first = messages[0];
  if (first !== undefined && first.getType() === 'system') {
    protectedMessages.push(first);
  }
  const firstHuman = messages.find((message) => message.getType() === 'human');
  if (firstHuman !== undefined && !protectedMessages.includes(firstHuman)) {
    protectedMessages.push(firstHuman);
  }
  return protectedMessages;
}

function selectRecentSummaryTail(messages: readonly BaseMessage[]): BaseMessage[] {
  const included = new Set<BaseMessage>();
  const maxIteration = findMaxIteration(messages);
  if (maxIteration >= 0) {
    const keepAfter = maxIteration - SUMMARY_RECENT_ITERATIONS;
    for (const message of messages) {
      const iteration = readIterationFromMessage(message);
      if (iteration !== null && iteration > keepAfter) {
        included.add(message);
      }
    }
  } else {
    const start = Math.max(0, messages.length - SUMMARY_RECENT_FALLBACK_MESSAGES);
    for (let index = start; index < messages.length; index += 1) {
      included.add(messages[index]!);
    }
  }

  const latestHuman = [...messages].reverse().find((message) => message.getType() === 'human');
  if (latestHuman !== undefined) {
    included.add(latestHuman);
  }

  for (const pair of snapshotToolPairs(messages)) {
    if (included.has(pair.aiMessage) || included.has(pair.toolMessage)) {
      included.add(pair.aiMessage);
      included.add(pair.toolMessage);
    }
  }

  return messages.filter((message) => included.has(message));
}

function findMaxIteration(messages: readonly BaseMessage[]): number {
  let maxIteration = -1;
  for (const message of messages) {
    const iteration = readIterationFromMessage(message);
    if (iteration !== null && iteration > maxIteration) {
      maxIteration = iteration;
    }
  }
  return maxIteration;
}

function inferGoal(messages: readonly BaseMessage[]): string {
  const firstHuman = messages.find((message) => message.getType() === 'human');
  if (firstHuman === undefined) {
    return 'Maintain Roc DeepAgents runtime context.';
  }
  return contentToString(firstHuman.content).slice(0, 500);
}

function inferUserConstraints(messages: readonly BaseMessage[]): string[] {
  const constraints: string[] = [];
  for (const message of messages) {
    if (message.getType() !== 'human') {
      continue;
    }
    const content = contentToString(message.content);
    if (/must|必须|不要|不能|优先|only|never/u.test(content)) {
      constraints.push(content.slice(0, 500));
    }
  }
  return constraints.slice(0, 8);
}

function measureMessages(messages: readonly BaseMessage[]): number {
  return messages.reduce((total, message) => total + contentToString(message.content).length, 0);
}

function serializeMessages(messages: readonly BaseMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      content: contentToString(message.content),
      id: message.id,
      invalid_tool_calls: AIMessage.isInstance(message) ? message.invalid_tool_calls : undefined,
      tool_call_id: ToolMessage.isInstance(message) ? message.tool_call_id : undefined,
      tool_calls: AIMessage.isInstance(message) ? message.tool_calls : undefined,
      tool_name: ToolMessage.isInstance(message) ? message.name : undefined,
      tool_status: ToolMessage.isInstance(message) ? message.status : undefined,
      type: message.getType()
    }))
  );
}

function createEvent(
  input: Pick<RocContextCompactionOptions, 'mode' | 'runId' | 'threadId'>,
  type: ContextMaintenanceEvent['type'],
  stage: ContextMaintenanceStage
): ContextMaintenanceEvent {
  return {
    type,
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    stage
  };
}

function contentToString(content: BaseMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content);
}
