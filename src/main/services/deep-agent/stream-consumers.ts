import type { ChatRunEvent, TaskRun } from '../../../shared/types';
import * as recordUtils from './record-utils';
import { redact } from './redact';

type ReasoningSource =
  | {
      kind: 'stream';
      stream: AsyncIterable<unknown>;
    }
  | {
      kind: 'values';
      values: string[];
    };

type StreamConsumerContext = {
  runId: string;
  taskRun: TaskRun | null;
};

type StreamConsumerCallbacks = {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  emitTodoEvent: (candidate: unknown) => void;
  markVisibleOutput?: () => void;
  recordTaskEvent: (
    type: 'message_delta' | 'reasoning_delta' | 'tool_call' | 'subagent_started' | 'subagent_completed',
    payload: Record<string, unknown>
  ) => void;
};

const maxPersistedAssistantDeltaChars = 512;

export type ProviderUsageAccumulator = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export function createUsageAccumulator(): ProviderUsageAccumulator {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null
  };
}

export async function consumeMessageStream(input: {
  messages: AsyncIterable<unknown>;
  context: StreamConsumerContext;
  assistantChunks: string[];
  reasoningChunks: string[];
  usageAccumulator: ProviderUsageAccumulator;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  const assistantDeltaRecorder = createAssistantDeltaRecorder(input.context, input.callbacks);
  const reasoningDeltaRecorder = createReasoningDeltaRecorder(input.context, input.callbacks);
  for await (const message of input.messages) {
    updateUsageAccumulator(input.usageAccumulator, message);
    const textStream = recordUtils.readAsyncIterable(recordUtils.readRecordValue(message, 'text'));
    const reasoningSource = readReasoningSource(message);
    const canStreamAssistantText =
      textStream !== null &&
      !recordUtils.isNonAssistantTextMessage(message) &&
      !recordUtils.isSummarizationMessage(message);

    const tasks: Array<Promise<void>> = [];
    if (canStreamAssistantText) {
      tasks.push(
        consumeVisibleTextStream(textStream as AsyncIterable<unknown>, (delta) => {
          input.callbacks.markVisibleOutput?.();
          input.assistantChunks.push(delta);
          assistantDeltaRecorder.record(delta);
          input.callbacks.emitRuntimeEvent({
            type: 'message_delta',
            runId: input.context.runId,
            delta
          });
        })
      );
    }
    if (reasoningSource !== null) {
      tasks.push(
        consumeReasoningSource({
          source: reasoningSource,
          context: input.context,
          reasoningChunks: input.reasoningChunks,
          callbacks: input.callbacks,
          reasoningDeltaRecorder
        })
      );
    }
    await Promise.all(tasks);

    if (reasoningSource === null && input.reasoningChunks.length === 0) {
      const trailingReasoning = await readReasoningFromOutput(message);
      if (trailingReasoning !== null) {
        await consumeVisibleTextStream(createStringAsyncIterable([trailingReasoning]), (delta) => {
          input.callbacks.markVisibleOutput?.();
          input.reasoningChunks.push(delta);
          reasoningDeltaRecorder.record(delta);
          input.callbacks.emitRuntimeEvent({
            type: 'reasoning_delta',
            runId: input.context.runId,
            delta
          });
        });
      }
    }
  }
  assistantDeltaRecorder.flush();
  reasoningDeltaRecorder.flush();
}

function createBoundedTaskDeltaRecorder(
  context: StreamConsumerContext,
  callbacks: StreamConsumerCallbacks,
  type: 'message_delta' | 'reasoning_delta',
  buildPayload: (delta: string) => Record<string, unknown>
): {
  record: (delta: string) => void;
  flush: () => void;
} {
  let pendingDelta = '';

  function recordChunk(delta: string): void {
    callbacks.recordTaskEvent(type, buildPayload(delta));
  }

  function flushCompleteChunks(): void {
    while (pendingDelta.length >= maxPersistedAssistantDeltaChars) {
      recordChunk(pendingDelta.slice(0, maxPersistedAssistantDeltaChars));
      pendingDelta = pendingDelta.slice(maxPersistedAssistantDeltaChars);
    }
  }

  function flush(): void {
    if (context.taskRun === null || pendingDelta.length === 0) {
      pendingDelta = '';
      return;
    }
    recordChunk(pendingDelta);
    pendingDelta = '';
  }

  return {
    record: (delta) => {
      if (context.taskRun === null) {
        return;
      }
      pendingDelta += delta;
      if (pendingDelta.length >= maxPersistedAssistantDeltaChars) {
        flushCompleteChunks();
      }
    },
    flush
  };
}

function createAssistantDeltaRecorder(
  context: StreamConsumerContext,
  callbacks: StreamConsumerCallbacks
): {
  record: (delta: string) => void;
  flush: () => void;
} {
  return createBoundedTaskDeltaRecorder(context, callbacks, 'message_delta', (delta) => ({
    role: 'assistant',
    delta
  }));
}

function createReasoningDeltaRecorder(
  context: StreamConsumerContext,
  callbacks: StreamConsumerCallbacks
): {
  record: (delta: string) => void;
  flush: () => void;
} {
  return createBoundedTaskDeltaRecorder(context, callbacks, 'reasoning_delta', (delta) => ({
    delta
  }));
}

export async function consumeToolCallStream(input: {
  calls: AsyncIterable<unknown>;
  context: StreamConsumerContext;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  for await (const call of input.calls) {
    const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(call, 'name')) ?? 'unknown_tool';
    const rawCallInput = await Promise.resolve(recordUtils.readRecordValue(call, 'input'));
    const callInput = redactUnknown(rawCallInput);
    input.callbacks.markVisibleOutput?.();
    input.callbacks.emitRuntimeEvent({
      type: 'tool_event',
      runId: input.context.runId,
      event: 'start',
      name,
      data: callInput
    });
    if (input.context.taskRun !== null) {
      input.callbacks.recordTaskEvent('tool_call', {
        name,
        status: 'start',
        input: callInput
      });
    }
    input.callbacks.emitTodoEvent(callInput);

    try {
      const output = await Promise.resolve(recordUtils.readRecordValue(call, 'output'));
      input.callbacks.markVisibleOutput?.();
      input.callbacks.emitRuntimeEvent({
        type: 'tool_event',
        runId: input.context.runId,
        event: 'end',
        name,
        data: output
      });
      if (input.context.taskRun !== null) {
        input.callbacks.recordTaskEvent('tool_call', {
          name,
          status: 'end',
          output
        });
      }
      input.callbacks.emitTodoEvent(output);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : 'Tool 执行失败。');
      input.callbacks.markVisibleOutput?.();
      input.callbacks.emitRuntimeEvent({
        type: 'tool_event',
        runId: input.context.runId,
        event: 'error',
        name,
        data: message
      });
      if (input.context.taskRun !== null) {
        input.callbacks.recordTaskEvent('tool_call', {
          name,
          status: 'error',
          error: message
        });
      }
    }
  }
}

export async function consumeSubagentStream(input: {
  subagents: AsyncIterable<unknown>;
  context: StreamConsumerContext;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  for await (const subagent of input.subagents) {
    const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(subagent, 'name')) ?? 'subagent';
    const taskInput = await Promise.resolve(recordUtils.readRecordValue(subagent, 'taskInput'));
    const summary = recordUtils.readNonEmptyString(taskInput) ?? null;
    input.callbacks.markVisibleOutput?.();
    input.callbacks.emitRuntimeEvent({
      type: 'subagent_event',
      runId: input.context.runId,
      subagent: name,
      status: 'started',
      summary
    });
    if (input.context.taskRun !== null) {
      input.callbacks.recordTaskEvent('subagent_started', {
        name,
        summary
      });
    }

    try {
      await Promise.resolve(recordUtils.readRecordValue(subagent, 'output'));
      input.callbacks.markVisibleOutput?.();
      input.callbacks.emitRuntimeEvent({
        type: 'subagent_event',
        runId: input.context.runId,
        subagent: name,
        status: 'completed',
        summary
      });
      if (input.context.taskRun !== null) {
        input.callbacks.recordTaskEvent('subagent_completed', {
          name,
          summary
        });
      }
    } catch (error) {
      const failureSummary = error instanceof Error ? error.message : summary;
      input.callbacks.markVisibleOutput?.();
      input.callbacks.emitRuntimeEvent({
        type: 'subagent_event',
        runId: input.context.runId,
        subagent: name,
        status: 'failed',
        summary: failureSummary
      });
    }
  }
}

function updateUsageAccumulator(target: ProviderUsageAccumulator, message: unknown): void {
  const usageMetadata = recordUtils.readRecordValue(message, 'usage_metadata');
  const inputTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'input_tokens'));
  const outputTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'output_tokens'));
  const totalTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'total_tokens'));
  const inputTokenDetails = recordUtils.readRecordValue(usageMetadata, 'input_token_details');
  const cacheReadTokens = readNonNegativeInteger(recordUtils.readRecordValue(inputTokenDetails, 'cache_read'));
  const cacheCreationTokens = readNonNegativeInteger(recordUtils.readRecordValue(inputTokenDetails, 'cache_creation'));

  if (inputTokens !== null) {
    target.promptTokens = inputTokens;
  }
  if (outputTokens !== null) {
    target.completionTokens = outputTokens;
  }
  if (totalTokens !== null) {
    target.totalTokens = totalTokens;
  }
  if (cacheReadTokens !== null) {
    target.cacheReadTokens = cacheReadTokens;
  }
  if (cacheCreationTokens !== null) {
    target.cacheCreationTokens = cacheCreationTokens;
  }
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

async function consumeReasoningSource(input: {
  source: ReasoningSource;
  context: StreamConsumerContext;
  reasoningChunks: string[];
  callbacks: StreamConsumerCallbacks;
  reasoningDeltaRecorder: {
    record: (delta: string) => void;
  };
}): Promise<void> {
  const onDelta = (delta: string) => {
    input.callbacks.markVisibleOutput?.();
    input.reasoningChunks.push(delta);
    input.reasoningDeltaRecorder.record(delta);
    input.callbacks.emitRuntimeEvent({
      type: 'reasoning_delta',
      runId: input.context.runId,
      delta
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

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (recordUtils.isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry)])
    );
  }
  return value;
}
