import { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ChatRunEvent, GuardrailNudgePayload, TaskRun } from '../../../shared/types';
import {
  FORGE_TRANSIENT_TYPES,
  readForgeMessageTag,
  readForgeNudgeVisibility,
  type ForgeMessageType
} from '../forge-guardrails';
import * as recordUtils from './record-utils';
import { redact } from './redact';
import { projectSubagentStream } from './subagent-projection';
import {
  buildToolCallChunkData,
  readContentBlocks,
  readToolCallId,
  readToolChunkId,
  redactUnknown
} from './stream-tool-utils';
import {
  createUsageAccumulator,
  updateUsageAccumulator,
  type ProviderUsageAccumulator
} from './stream-usage-accumulator';

export { createUsageAccumulator };
export type { ProviderUsageAccumulator };

type ReasoningSource =
  | {
      kind: 'stream';
      stream: AsyncIterable<unknown>;
    }
  | {
      kind: 'values';
      values: string[];
    };

type ToolCallChunkBlock = {
  name: string;
  data: Record<string, unknown>;
};

type StreamGuardrailNudgePayload = GuardrailNudgePayload & {
  visibility: 'internal' | 'visible';
};

type StreamConsumerContext = {
  runId: string;
  taskRun: TaskRun | null;
};

type StreamConsumerCallbacks = {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  emitTodoEvent: (candidate: unknown) => void;
  markVisibleOutput?: () => void;
  recordSessionToolCall?: (name: string, input: unknown, output: unknown) => void;
  recordTaskEvent: (type: 'guardrail_nudge', payload: Record<string, unknown>) => void;
};

export async function consumeMessageStream(input: {
  messages: AsyncIterable<unknown>;
  context: StreamConsumerContext;
  assistantChunks: string[];
  reasoningChunks: string[];
  usageAccumulator: ProviderUsageAccumulator;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  for await (const message of input.messages) {
    updateUsageAccumulator(input.usageAccumulator, message);
    const guardrailNudge = readGuardrailNudgePayload(message);
    if (guardrailNudge !== null) {
      const { visibility, ...payload } = guardrailNudge;
      if (visibility === 'visible') {
        input.callbacks.recordTaskEvent('guardrail_nudge', payload);
      }
      continue;
    }

    const standardTextStream = recordUtils.readAsyncIterable(recordUtils.readRecordValue(message, 'text'));
    const textStream = standardTextStream ?? readContentBlockTextSource(message);
    const reasoningSource = readReasoningSource(message);
    const toolCallChunks = readToolCallChunkBlocks(message);
    const canStreamAssistantText =
      textStream !== null &&
      (standardTextStream === null || !recordUtils.isNonAssistantTextMessage(message)) &&
      !recordUtils.isSummarizationMessage(message);

    emitToolCallChunkActivity(toolCallChunks, input.context, input.callbacks);
    const projectionTasks: Array<Promise<void>> = [];
    if (reasoningSource !== null) {
      projectionTasks.push(
        consumeReasoningSource({
          source: reasoningSource,
          context: input.context,
          reasoningChunks: input.reasoningChunks,
          callbacks: input.callbacks
        })
      );
    }
    if (canStreamAssistantText && textStream !== null) {
      projectionTasks.push(
        consumeVisibleTextStream(textStream, (delta) => {
          input.callbacks.markVisibleOutput?.();
          input.assistantChunks.push(delta);
          input.callbacks.emitRuntimeEvent({
            type: 'assistant_block',
            runId: input.context.runId,
            block: {
              kind: 'text',
              blockId: `text-${input.context.runId}`,
              phase: 'delta',
              text: delta
            }
          });
        })
      );
    }
    if (projectionTasks.length > 0) {
      await Promise.all(projectionTasks);
    }

    if (reasoningSource === null && input.reasoningChunks.length === 0) {
      const trailingReasoning = await readReasoningFromOutput(message);
      if (trailingReasoning !== null) {
        await consumeVisibleTextStream(createStringAsyncIterable([trailingReasoning]), (delta) => {
          input.callbacks.markVisibleOutput?.();
          input.reasoningChunks.push(delta);
          input.callbacks.emitRuntimeEvent({
            type: 'assistant_block',
            runId: input.context.runId,
            block: {
              kind: 'reasoning',
              blockId: `reasoning-${input.context.runId}`,
              phase: 'delta',
              text: delta
            }
          });
        });
      }
    }
  }
}

export async function consumeToolCallStream(input: {
  calls: AsyncIterable<unknown>;
  context: StreamConsumerContext;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  for await (const call of input.calls) {
    const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(call, 'name')) ?? 'unknown_tool';
    const callId = readToolCallId(call);
    if (callId === null) {
      continue;
    }
    const rawCallInput = await Promise.resolve(recordUtils.readRecordValue(call, 'input'));
    const callInput = redactUnknown(rawCallInput);
    input.callbacks.markVisibleOutput?.();
    input.callbacks.emitRuntimeEvent({
      type: 'assistant_block',
      runId: input.context.runId,
      block: {
        kind: 'tool_call',
        blockId: `tool-${callId}`,
        callId,
        name,
        phase: 'start',
        input: callInput
      }
    });
    input.callbacks.emitTodoEvent(callInput);

    try {
      const output = await Promise.resolve(recordUtils.readRecordValue(call, 'output'));
      input.callbacks.markVisibleOutput?.();
      input.callbacks.emitRuntimeEvent({
        type: 'assistant_block',
        runId: input.context.runId,
        block: {
          kind: 'tool_call',
          blockId: `tool-${callId}`,
          callId,
          name,
          phase: 'end',
          input: callInput,
          output
        }
      });
      input.callbacks.recordSessionToolCall?.(name, callInput, output);
      input.callbacks.emitTodoEvent(output);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : 'Tool 执行失败。');
      input.callbacks.markVisibleOutput?.();
      input.callbacks.emitRuntimeEvent({
        type: 'assistant_block',
        runId: input.context.runId,
        block: {
          kind: 'tool_call',
          blockId: `tool-${callId}`,
          callId,
          name,
          phase: 'error',
          input: callInput,
          error: message
        }
      });
      input.callbacks.recordSessionToolCall?.(name, callInput, { error: message });
    }
  }
}

export async function consumeSubagentStream(input: {
  subagents: AsyncIterable<unknown>;
  context: StreamConsumerContext;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  await projectSubagentStream({
    subagents: input.subagents,
    runId: input.context.runId,
    callbacks: input.callbacks
  });
}

async function readReasoningFromOutput(message: unknown): Promise<string | null> {
  return await recordUtils.readReasoningFromMessageOutput(recordUtils.readRecordValue(message, 'output'));
}

function readReasoningSource(message: unknown): ReasoningSource | null {
  const standardReasoning = readReasoningFallbackValue(recordUtils.readRecordValue(message, 'reasoning'));
  if (standardReasoning !== null) {
    return standardReasoning;
  }

  const values = recordUtils.readReasoningTextValues(message);
  if (values.length === 0) {
    return null;
  }
  return {
    kind: 'values',
    values
  };
}

function readReasoningFallbackValue(value: unknown): ReasoningSource | null {
  const stream = recordUtils.readAsyncIterable(value);
  if (stream !== null) {
    return {
      kind: 'stream',
      stream
    };
  }
  const text = recordUtils.readNonEmptyString(value);
  if (text === null) {
    return null;
  }
  return {
    kind: 'values',
    values: [text]
  };
}

function readContentBlockTextSource(message: unknown): AsyncIterable<unknown> | null {
  if (recordUtils.isSummarizationMessage(message) || hasSkillInstructionPath(message)) {
    return null;
  }

  const values = readContentBlocks(message).flatMap((block) => {
    if (!recordUtils.isRecord(block)) {
      return [];
    }
    const type = readLowercaseString(recordUtils.readRecordValue(block, 'type'));
    if (type !== 'text' || hasSkillInstructionPath(block)) {
      return [];
    }
    const text = recordUtils.readNonEmptyString(recordUtils.readRecordValue(block, 'text'));
    if (text === null || recordUtils.classifyStreamedAssistantText(text) === 'non_assistant') {
      return [];
    }
    return [{ text }];
  });

  if (values.length === 0) {
    return null;
  }
  return createStringAsyncIterable(values.map((block) => block.text));
}

function readToolCallChunkBlocks(message: unknown): ToolCallChunkBlock[] {
  return readContentBlocks(message).flatMap((block) => {
    if (!recordUtils.isRecord(block)) {
      return [];
    }
    const type = readLowercaseString(recordUtils.readRecordValue(block, 'type'));
    if (type !== 'tool_call_chunk' && type !== 'server_tool_call_chunk') {
      return [];
    }

    const name =
      recordUtils.readNonEmptyString(recordUtils.readRecordValue(block, 'name')) ??
      recordUtils.readNonEmptyString(recordUtils.readRecordValue(block, 'tool_name')) ??
      'unknown_tool';
    const data = buildToolCallChunkData(block);
    return [{ name, data }];
  });
}

function emitToolCallChunkActivity(
  chunks: readonly ToolCallChunkBlock[],
  context: StreamConsumerContext,
  callbacks: StreamConsumerCallbacks
): void {
  chunks.forEach((chunk, index) => {
    const chunkId = readToolChunkId(chunk, index);
    callbacks.markVisibleOutput?.();
    callbacks.emitRuntimeEvent({
      type: 'assistant_block',
      runId: context.runId,
      block: {
        kind: 'tool_call',
        blockId: `tool-${chunkId}`,
        callId: chunkId,
        name: chunk.name,
        phase: 'progress',
        input: chunk.data
      }
    });
    callbacks.emitTodoEvent(chunk.data);
  });
}

function hasSkillInstructionPath(value: unknown): boolean {
  if (!recordUtils.isRecord(value)) {
    return false;
  }
  const path = recordUtils.readNonEmptyString(recordUtils.readRecordValue(value, 'path'));
  if (path !== null && path.replaceAll('\\', '/').toLowerCase().endsWith('/skill.md')) {
    return true;
  }
  return hasSkillInstructionPath(recordUtils.readRecordValue(value, 'additional_kwargs'));
}

function readLowercaseString(value: unknown): string | null {
  const text = recordUtils.readNonEmptyString(value);
  return text === null ? null : text.toLowerCase();
}

async function consumeReasoningSource(input: {
  source: ReasoningSource;
  context: StreamConsumerContext;
  reasoningChunks: string[];
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  const onDelta = (delta: string) => {
    input.callbacks.markVisibleOutput?.();
    input.reasoningChunks.push(delta);
    input.callbacks.emitRuntimeEvent({
      type: 'assistant_block',
      runId: input.context.runId,
      block: {
        kind: 'reasoning',
        blockId: `reasoning-${input.context.runId}`,
        phase: 'delta',
        text: delta
      }
    });
  };

  if (input.source.kind === 'stream') {
    await consumeVisibleTextStream(input.source.stream, onDelta);
    return;
  }

  await consumeVisibleTextStream(createStringAsyncIterable(input.source.values), onDelta);
}

async function consumeStringStream(stream: AsyncIterable<unknown>, onDelta: (delta: string) => void): Promise<void> {
  for await (const item of stream) {
    const text = recordUtils.readNonEmptyString(item);
    if (text !== null) {
      onDelta(text);
    }
  }
}

async function consumeVisibleTextStream(
  stream: AsyncIterable<unknown>,
  onDelta: (delta: string) => void
): Promise<void> {
  let pending = '';
  let released = false;
  let suppressMessage = false;

  await consumeStringStream(stream, (delta) => {
    if (suppressMessage) {
      return;
    }

    if (released) {
      onDelta(delta);
      return;
    }

    pending += delta;
    const classification = recordUtils.classifyStreamedAssistantText(pending);
    if (classification === 'non_assistant') {
      pending = '';
      suppressMessage = true;
      return;
    }
    if (classification === 'pending') {
      return;
    }

    released = true;
    if (pending.length > 0) {
      onDelta(pending);
    }
    pending = '';
  });

  if (!released && !suppressMessage && pending.length > 0) {
    onDelta(pending);
  }
}

async function* createStringAsyncIterable(values: readonly string[]): AsyncGenerator<string> {
  for (const value of values) {
    yield value;
  }
}

function readGuardrailNudgePayload(message: unknown): StreamGuardrailNudgePayload | null {
  if (!BaseMessage.isInstance(message)) {
    return null;
  }

  const tag = readForgeMessageTag(message);
  if (tag === null || !isGuardrailNudgeTag(tag)) {
    return null;
  }

  const payload: GuardrailNudgePayload = {
    nudgeKind: forgeTagToNudgeKind(tag),
    content: typeof message.content === 'string' ? redact(message.content) : ''
  };
  const tier = readNudgeTier(message);
  if (tier !== null) {
    payload.tier = tier;
  }
  if (ToolMessage.isInstance(message)) {
    payload.toolCallId = message.tool_call_id;
    if (message.name !== undefined) {
      payload.toolName = message.name;
    }
  }
  return {
    ...payload,
    visibility: readForgeNudgeVisibility(message)
  };
}

function isGuardrailNudgeTag(tag: ForgeMessageType): boolean {
  return FORGE_TRANSIENT_TYPES.has(tag) || tag === 'forge:tool_resolution';
}

function forgeTagToNudgeKind(tag: ForgeMessageType): GuardrailNudgePayload['nudgeKind'] {
  if (tag === 'forge:retry_nudge') {
    return 'retry';
  }
  if (tag === 'forge:unknown_tool_nudge') {
    return 'unknown_tool';
  }
  if (tag === 'forge:tool_resolution') {
    return 'tool_resolution';
  }
  if (tag === 'forge:context_warning') {
    return 'context_warning';
  }
  throw new Error(`Unsupported guardrail nudge tag: ${tag}`);
}

function readNudgeTier(message: BaseMessage): number | null {
  const value = message.additional_kwargs.forge_nudge_tier;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
