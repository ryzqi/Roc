import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createMiddleware } from 'langchain';

import {
  createForgeTieredCompactionEdits,
  type ForgeTieredCompactionOptions
} from '../../forge-guardrails/middleware/forge-tiered-compaction';
import { isContextDigestMessage } from '../../forge-guardrails/context-digest';
import {
  ContextArtifactStore,
  formatContextArtifactReference
} from './context-artifact-store';
import {
  contextSummaryToDigestMessage,
  summarizeWithCurrentModel,
  type ContextSummary,
  type ContextSummaryInput
} from './context-summary';

const DEFAULT_TOOL_RESULT_PERSIST_CHARS = 30_000;
const SUMMARY_THRESHOLD = 0.9;
const DIGEST_INSERT_AFTER_SYSTEM = 1;

export type ContextCompactionMode = 'chat' | 'task' | 'plan';

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
};

export type RocContextCompactionOptions = {
  artifactStore: ContextArtifactStore;
  budgetTokens: number;
  emitEvent: (event: ContextMaintenanceEvent) => void;
  mode: ContextCompactionMode;
  model: Pick<BaseChatModel, 'invoke'>;
  runId: string;
  threadId: string;
  toolResultPersistChars?: number;
  workspaceHash: string | null;
  workspacePath: string | null;
};

type RunCompactionInput = RocContextCompactionOptions & {
  countTokens: (messages: BaseMessage[]) => Promise<number>;
  messages: BaseMessage[];
  summarize?: (input: ContextSummaryInput) => Promise<ContextSummary>;
};

type ToolPairSnapshot = {
  aiMessage: AIMessage;
  toolCallId: string;
  toolMessage: ToolMessage;
};

export function createRocContextCompactionMiddleware(options: RocContextCompactionOptions) {
  return createMiddleware({
    name: 'RocContextCompactionPipeline',
    beforeModel: async (state) => {
      await runContextCompactionForTest({
        ...options,
        messages: state.messages,
        countTokens: estimateTokens,
        summarize: async (input) => await summarizeWithCurrentModel({ ...input, model: options.model })
      });
      return undefined;
    }
  });
}

export async function runContextCompactionForTest(input: RunCompactionInput): Promise<void> {
  let stage: ContextMaintenanceStage = 'persist';
  try {
    input.emitEvent(createEvent(input, 'context_compaction_started', stage));
    const artifactReferences = persistLargeToolResults(input);
    const beforeDeterministicMessages = [...input.messages];
    const toolPairs = snapshotToolPairs(input.messages);
    const beforeDeterministicChars = measureMessages(input.messages);

    stage = 'deterministic';
    await runDeterministicCompaction(input);
    restoreIncompleteToolPairs(input.messages, toolPairs);
    const afterDeterministicChars = measureMessages(input.messages);
    input.emitEvent({
      ...createEvent(input, 'context_deterministic_compacted', stage),
      removedChars: Math.max(0, beforeDeterministicChars - afterDeterministicChars)
    });

    const tokensAfterDeterministic = await input.countTokens(input.messages);
    if (tokensAfterDeterministic < input.budgetTokens * SUMMARY_THRESHOLD) {
      input.emitEvent(createEvent(input, 'context_summary_skipped', 'summary'));
      return;
    }

    stage = 'summary';
    input.emitEvent(createEvent(input, 'context_summary_started', stage));
    const summary = await summarizeContext(input, artifactReferences, beforeDeterministicMessages);
    const digestMessage = contextSummaryToDigestMessage(summary);
    upsertDigestMessage(input.messages, digestMessage);
    input.artifactStore.recordPreCompactionFlush({
      content: digestMessage.content.toString(),
      runId: input.runId,
      threadId: input.threadId,
      tokenCount: await input.countTokens([digestMessage]),
      workspaceHash: input.workspaceHash
    });
    input.emitEvent(createEvent(input, 'context_summary_completed', stage));
  } catch (error) {
    input.emitEvent(createEvent(input, 'context_compaction_failed', stage));
    throw error;
  }
}

function persistLargeToolResults(input: RunCompactionInput): string[] {
  const references: string[] = [];
  const threshold =
    input.toolResultPersistChars === undefined ? DEFAULT_TOOL_RESULT_PERSIST_CHARS : input.toolResultPersistChars;
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]!;
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
    references.push(reference);
    input.messages[index] = new ToolMessage({
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
  return references;
}

async function runDeterministicCompaction(input: RunCompactionInput): Promise<void> {
  const options: ForgeTieredCompactionOptions = {
    budgetTokens: input.budgetTokens
  };
  const edits = createForgeTieredCompactionEdits(options);
  for (const edit of edits) {
    await edit.apply({
      messages: input.messages,
      countTokens: input.countTokens
    });
  }
}

function snapshotToolPairs(messages: BaseMessage[]): ToolPairSnapshot[] {
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
      const toolResult = toolResults.get(toolCall.id);
      if (toolResult === undefined) {
        continue;
      }
      pairs.push({
        aiMessage: message,
        toolCallId: toolCall.id,
        toolMessage: toolResult
      });
    }
  }
  return pairs;
}

function restoreIncompleteToolPairs(messages: BaseMessage[], pairs: readonly ToolPairSnapshot[]): void {
  for (const pair of pairs) {
    const aiIndex = messages.findIndex((message) => message === pair.aiMessage);
    const toolIndex = messages.findIndex((message) => message === pair.toolMessage);
    if (aiIndex >= 0 && toolIndex === -1) {
      messages.splice(aiIndex + 1, 0, pair.toolMessage);
      continue;
    }
    if (aiIndex === -1 && toolIndex >= 0) {
      messages.splice(toolIndex, 0, pair.aiMessage);
    }
  }
}

async function summarizeContext(
  input: RunCompactionInput,
  artifactReferences: readonly string[],
  beforeDeterministicMessages: readonly BaseMessage[]
): Promise<ContextSummary> {
  const summarize =
    input.summarize === undefined
      ? async (summaryInput: ContextSummaryInput) => await summarizeWithCurrentModel({ ...summaryInput, model: input.model })
      : input.summarize;
  return await summarize({
    artifactReferences,
    goal: inferGoal(beforeDeterministicMessages),
    messages: beforeDeterministicMessages,
    recentMessages: input.messages.slice(-6),
    userConstraints: inferUserConstraints(beforeDeterministicMessages),
    workspacePath: input.workspacePath
  });
}

function upsertDigestMessage(messages: BaseMessage[], digestMessage: AIMessage): void {
  const existingIndex = messages.findIndex(isContextDigestMessage);
  if (existingIndex >= 0) {
    messages[existingIndex] = digestMessage;
    return;
  }
  const first = messages[0];
  const insertIndex = first !== undefined && first.getType() === 'system' ? DIGEST_INSERT_AFTER_SYSTEM : 0;
  messages.splice(insertIndex, 0, digestMessage);
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

async function estimateTokens(messages: BaseMessage[]): Promise<number> {
  return Math.ceil(JSON.stringify(messages.map((message) => message.content)).length / 4);
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
