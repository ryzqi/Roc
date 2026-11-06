import { createHash, randomUUID } from 'node:crypto';
import { AIMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

import { collectContextRequirements, contextEvidenceLocators, isContextContract, pinContextContractWithAudit, type ContextControlState } from './context-contract';
import { createEmptyContextContractAudit, type ContextContractAudit, type ContextCompactionRecord } from '../../../../shared/schemas/run-diagnostics';
import type { RunExecutionSnapshot } from '../../../../shared/types';
import type { RunBudgetObserver } from '../run-budget-observer';

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
  deriveContextBudgetProfile,
  type ContextBudgetProfile,
  type ContextTokenCounter
} from './context-token-budget';

const DEFAULT_TOOL_RESULT_PERSIST_CHARS = 30_000;
const SUMMARY_THRESHOLD = 0.9;
const SUMMARY_RECENT_ITERATIONS = 2;
const SUMMARY_RECENT_FALLBACK_MESSAGES = 6;

export type ContextCompactionMode = RunExecutionSnapshot['mode'];

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
  cycleId?: string;
  contractAudit?: ContextContractAudit;
  record?: ContextCompactionRecord;
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
  readControlState: () => ContextControlState;
  artifactRecoveryEnabled?: boolean;
  budgetProfile: ContextBudgetProfile;
  callbacks?: RunnableConfig['callbacks'];
  budgetObserver?: RunBudgetObserver;
  emitEvent: (event: ContextMaintenanceEvent) => void;
  mode: ContextCompactionMode;
  model: Pick<BaseChatModel, 'invoke'> & Partial<Pick<BaseChatModel, 'getNumTokens'>>;
  runId: string;
  sessionHistory: PreCompactionFlushRecorder;
  threadId: string;
  tokenCounter: ContextTokenCounter;
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
  const tokenCounter = options.tokenCounter;
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
        summarize: async (input) => await summarizeWithCurrentModel({
          ...input,
          model: options.model,
          callbacks: options.callbacks,
          budgetObserver: options.budgetObserver
        })
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
        const name = tool.name;
        const description = tool.description;
        if (typeof name !== 'string') {
          throw new Error('agent_tool_name_missing');
        }
        if (typeof description !== 'string') {
          throw new Error(`agent_tool_description_missing:${name}`);
        }
        return {
          name,
          description,
          schema: tool.schema
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
  const emitEvent = input.emitEvent;
  const cycleId = randomUUID();
  input = { ...input, emitEvent: event => emitEvent({ ...event, cycleId }) };
  return input.budgetObserver === undefined ? await runContextCompactionStages(input) :
    await input.budgetObserver.withContextCycle(cycleId, () => runContextCompactionStages(input));
}

async function runContextCompactionStages(input: RunCompactionInput): Promise<BaseMessage[]> {
  let stage: ContextMaintenanceStage = 'persist';
  let contractAudit = createEmptyContextContractAudit();
  const record: ContextCompactionRecord = {reason: 'maintenance', sourceMessageCount: input.messages.length,
    sourceHash: createHash('sha256').update(serializeMessages(input.messages)).digest('hex'),
    summaryHash: null, artifactRefs: [], risks: []};
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
    const deterministicContract = pinContextContractWithAudit(
      messages,
      input.messages,
      input.readControlState(),
      artifacts.map(formatContextArtifactLocator),
      input.workspaceHash
    );
    messages = deterministicContract.messages;
    contractAudit = deterministicContract.audit;
    record.artifactRefs = verifyOriginalEvidence(input, messages);
    const afterDeterministicChars = measureMessages(messages);
    const deterministicTokens = await input.countTokens(messages);
    input.emitEvent({
      ...createEvent(input, 'context_deterministic_compacted', stage),
      removedChars: Math.max(0, beforeDeterministicChars - afterDeterministicChars),
      inputTokens: deterministicTokens,
      budgetTokens: input.budgetProfile.modelInputTokens,
      estimated: input.countTokensEstimated?.() === true,
      contractAudit, record: structuredClone(record)
    });
    requirePreservedContract(contractAudit);

    const tokensAfterDeterministic = deterministicTokens;
    if (tokensAfterDeterministic < input.budgetProfile.modelInputTokens * SUMMARY_THRESHOLD) {
      input.emitEvent({
        ...createEvent(input, 'context_summary_skipped', 'summary'),
        contractAudit
      });
      return messages;
    }

    stage = 'summary';
    record.reason = 'context_pressure';
    input.emitEvent(createEvent(input, 'context_summary_started', stage));
    const summaryMessages = selectMessagesToSummarize(messages);
    record.sourceMessageCount = summaryMessages.length;
    record.sourceHash = createHash('sha256').update(serializeMessages(summaryMessages)).digest('hex');
    const preparedSummary = await prepareSummaryInput(
      input,
      artifacts,
      summaryMessages,
      beforeDeterministicMessages
    );
    const summary = await summarizeContext(input, preparedSummary.summaryInput);
    record.summaryHash = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
    const digestMessage = contextSummaryToDigestMessage({
      ...summary,
      toolEvidence: [...new Set([...summary.toolEvidence, ...preparedSummary.artifactLocators])]
    });
    messages = compactToSummaryTail(messages, digestMessage);
    const pinned = pinContextContractWithAudit(
      messages,
      input.messages,
      input.readControlState(),
      preparedSummary.artifactLocators,
      input.workspaceHash
    );
    contractAudit = pinned.audit;
    requirePreservedContract(contractAudit);
    messages = pinned.messages;
    record.artifactRefs = verifyOriginalEvidence(input, messages);
    record.risks.push('lossy_summary');
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
      estimated: input.countTokensEstimated?.() === true,
      contractAudit, record: structuredClone(record)
    });
    return messages;
  } catch (error) {
    record.risks.push(error instanceof Error && (error.message === 'context_evidence_unverifiable' || error.message.startsWith('context_artifact_'))
      ? 'evidence_unverifiable' : 'compaction_failed');
    input.emitEvent({
      ...createEvent(input, 'context_compaction_failed', stage),
      contractAudit, record: structuredClone(record)
    });
    throw error;
  }
}

function requirePreservedContract(audit: ContextContractAudit): void {
  const lost = audit.missingConstraintCount + audit.missingAcceptanceConditionCount +
    audit.missingPendingEffectCount + audit.missingPendingApprovalCount + audit.missingPendingCorrectionCount +
    audit.missingEvidenceLocatorCount + audit.invalidContractCount + audit.invalidEvidenceLocatorCount;
  if (lost > 0) throw new Error('context_contract_required_data_lost');
}

function verifyOriginalEvidence(input: RunCompactionInput, messages: readonly BaseMessage[]): ContextCompactionRecord['artifactRefs'] {
  return contextEvidenceLocators(messages).map(locator => {
    const lines = locator.split('\n');
    const artifactId = lines[1]!.slice('artifactId: '.length), sha256 = lines[2]!.slice('sha256: '.length);
    // The store checks thread/workspace ownership, expiry and actual content hash before returning content.
    const artifact = input.artifactStore.readArtifact({artifactId, expectedSha256: sha256,
      threadId: input.threadId, workspaceHash: input.workspaceHash});
    if (artifact === null || formatContextArtifactLocator(artifact) !== locator) throw new Error('context_evidence_unverifiable');
    return {artifactId, sha256};
  });
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
  // A pending call may precede many turns (for example while waiting for approval).
  // Tiered history edits cannot discard it before the summary protection runs.
  for (const message of pendingToolMessages(messages)) {
    if (working.includes(message)) continue;
    const next = messages.slice(messages.indexOf(message) + 1).find(candidate => working.includes(candidate));
    working.splice(next === undefined ? working.length : working.indexOf(next), 0, message);
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
      ? async (summaryInput: ContextSummaryInput) => await summarizeWithCurrentModel({
          ...summaryInput,
          model: input.model,
          budgetObserver: input.budgetObserver
        })
      : input.summarize;
  return await summarize(summaryInput);
}

async function prepareSummaryInput(
  input: RunCompactionInput,
  artifacts: readonly PersistedContextArtifact[],
  messagesToSummarize: readonly BaseMessage[],
  allMessages: readonly BaseMessage[]
): Promise<{ artifactLocators: string[]; summaryInput: ContextSummaryInput }> {
  const workingMessages = [...messagesToSummarize];
  const references = artifacts.map(formatContextArtifactLocator);
  const artifactLocators = artifacts.map(formatContextArtifactLocator);
  if (workingMessages.length > 0) {
    if (input.artifactRecoveryEnabled === false) throw new Error('context_summary_recovery_unavailable');
    const artifact = input.artifactStore.persistArtifact({
      content: serializeMessages(workingMessages), kind: 'transcript',
      runId: input.runId, threadId: input.threadId, workspaceHash: input.workspaceHash
    });
    references.push(formatContextArtifactLocator(artifact));
    artifactLocators.push(formatContextArtifactLocator(artifact));
  }
  let summaryInput = createSummaryInput(input, references, workingMessages, allMessages);
  const measured = await countSummaryInput(input, summaryInput);
  if (measured.tokens <= input.budgetProfile.summaryInputTokens) {
    return { artifactLocators, summaryInput: addSummaryEstimate(summaryInput, measured) };
  }

  while (workingMessages.length > 0) {
    removeMessageGroup(workingMessages, 0);
    summaryInput = createSummaryInput(input, references, workingMessages, allMessages);
    const measurement = await countSummaryInput(input, summaryInput);
    if (measurement.tokens <= input.budgetProfile.summaryInputTokens) {
      return { artifactLocators, summaryInput: addSummaryEstimate(summaryInput, measurement) };
    }
  }
  throw new Error('context_summary_budget_exhausted');
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
    userConstraints: collectContextRequirements(allMessages, input.readControlState()),
    workspacePath: input.workspacePath
  };
}

async function countSummaryInput(
  input: RunCompactionInput,
  summaryInput: ContextSummaryInput
): Promise<{ tokens: number; estimated: boolean }> {
  const messageTokens = await input.countTokens(buildContextSummaryModelMessages(summaryInput));
  const messagesEstimated = input.countTokensEstimated?.() === true;
  const schemaText = JSON.stringify(z.toJSONSchema(contextSummarySchema));
  if (schemaText === undefined) {
    throw new Error('context_summary_schema_unserializable');
  }
  const schemaCount = await input.tokenCounter.countText(schemaText);
  return {
    tokens: messageTokens + schemaCount.tokens,
    estimated: messagesEstimated || schemaCount.estimated
  };
}

function addSummaryEstimate(
  input: ContextSummaryInput,
  measurement: { tokens: number; estimated: boolean }
): ContextSummaryInput {
  return {
    ...input,
    estimatedInputTokens: measurement.tokens,
    // Structured-output/tool encoding and provider framing are not exact text tokenization.
    estimateApproximate: true
  };
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

function selectProtectedHead(messages: readonly BaseMessage[]): BaseMessage[] {
  const protectedMessages = selectProtectedPrefix(messages);
  for (const human of messages.filter(message => message.getType() === 'human')) {
    if (!protectedMessages.includes(human)) protectedMessages.push(human);
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
  for (const contract of messages.filter(isContextContract)) {
    if (!protectedMessages.includes(contract)) protectedMessages.push(contract);
  }
  for (const message of pendingToolMessages(messages)) {
    if (!protectedMessages.includes(message)) protectedMessages.push(message);
  }
  return protectedMessages;
}

function pendingToolMessages(messages: readonly BaseMessage[]): BaseMessage[] {
  const protectedMessages: BaseMessage[] = [];
  const completedIds = new Set(messages.filter(ToolMessage.isInstance).map(message => message.tool_call_id));
  for (const message of messages) {
    if (!AIMessage.isInstance(message) || !message.tool_calls?.some(call => call.id === undefined || !completedIds.has(call.id))) continue;
    if (!protectedMessages.includes(message)) protectedMessages.push(message);
    const ids = new Set(message.tool_calls.map(call => call.id));
    for (const result of messages.filter(ToolMessage.isInstance)) {
      if (ids.has(result.tool_call_id) && !protectedMessages.includes(result)) protectedMessages.push(result);
    }
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
