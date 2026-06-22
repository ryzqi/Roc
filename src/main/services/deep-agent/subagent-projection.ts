import type { ChatAssistantBlock, ChatRunEvent, SubagentEventPayload, SubagentIdentity } from '../../../shared/types';
import * as recordUtils from './record-utils';
import { redact } from './redact';
import { readToolCallId, redactUnknown } from './stream-tool-utils';

export type SubagentProjectionCallbacks = {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  emitTodoEvent: (candidate: unknown) => void;
  markVisibleOutput?: () => void;
  recordSessionToolCall?: (name: string, input: unknown, output: unknown) => void;
};

type ProjectionContext = {
  idSegments: number[];
  nextSequence: () => number;
  parent: SubagentIdentity | null;
  path: string[];
  runId: string;
};

export async function projectSubagentStream(input: {
  subagents: AsyncIterable<unknown>;
  runId: string;
  callbacks: SubagentProjectionCallbacks;
}): Promise<void> {
  let sequence = 0;
  await consumeSubagents(
    input.subagents,
    {
      idSegments: [],
      nextSequence: () => {
        sequence += 1;
        return sequence;
      },
      parent: null,
      path: [],
      runId: input.runId
    },
    input.callbacks
  );
}

async function consumeSubagents(
  subagents: AsyncIterable<unknown>,
  context: ProjectionContext,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  let ordinal = 0;
  for await (const subagent of subagents) {
    await consumeOneSubagent(subagent, ordinal, context, callbacks);
    ordinal += 1;
  }
}

async function consumeOneSubagent(
  subagent: unknown,
  ordinal: number,
  context: ProjectionContext,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  const name = requireNonEmptyString(recordUtils.readRecordValue(subagent, 'name'), 'subagent_name_missing');
  const rawTaskInput = await Promise.resolve(recordUtils.readRecordValue(subagent, 'taskInput'));
  const taskInput = recordUtils.readNonEmptyString(rawTaskInput);
  const idSegments = [...context.idSegments, ordinal];
  const subagentId = `subagent-${context.runId}-${idSegments.join('-')}`;
  const path = [...context.path, `${name}#${ordinal}`];
  const asyncTaskId =
    recordUtils.readNonEmptyString(recordUtils.readRecordValue(subagent, 'asyncTaskId')) ??
    recordUtils.readNonEmptyString(recordUtils.readRecordValue(subagent, 'taskId')) ??
    undefined;
  const identity: SubagentIdentity = {
    subagentId,
    parentSubagentId: context.parent === null ? null : context.parent.subagentId,
    name,
    depth: context.path.length,
    path,
    execution: asyncTaskId === undefined ? 'sync' : 'async',
    taskInput,
    ...(asyncTaskId === undefined ? {} : { asyncTaskId })
  };

  emit(callbacks, context.runId, context.nextSequence(), identity, { kind: 'started' });

  const messages = recordUtils.readAsyncIterable(recordUtils.readRecordValue(subagent, 'messages'));
  const toolCalls = recordUtils.readAsyncIterable(recordUtils.readRecordValue(subagent, 'toolCalls'));
  const nested = recordUtils.readAsyncIterable(recordUtils.readRecordValue(subagent, 'subagents'));
  const projectionTasks: Array<Promise<void>> = [];
  if (messages !== null) {
    projectionTasks.push(consumeMessages(messages, context.runId, identity, context.nextSequence, callbacks));
  }
  if (toolCalls !== null) {
    projectionTasks.push(consumeToolCalls(toolCalls, context.runId, identity, context.nextSequence, callbacks));
  }
  if (nested !== null) {
    projectionTasks.push(
      consumeSubagents(
        nested,
        {
          idSegments,
          nextSequence: context.nextSequence,
          parent: identity,
          path,
          runId: context.runId
        },
        callbacks
      )
    );
  }
  await Promise.all(projectionTasks);

  try {
    const output = await Promise.resolve(recordUtils.readRecordValue(subagent, 'output'));
    emit(callbacks, context.runId, context.nextSequence(), identity, {
      kind: 'completed',
      summary: recordUtils.readNonEmptyString(output) ?? taskInput
    });
  } catch (error) {
    emit(callbacks, context.runId, context.nextSequence(), identity, {
      kind: 'failed',
      error: redact(error instanceof Error ? error.message : String(error))
    });
  }
}

async function consumeMessages(
  messages: AsyncIterable<unknown>,
  runId: string,
  identity: SubagentIdentity,
  nextSequence: () => number,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  for await (const message of messages) {
    const textSource = recordUtils.readRecordValue(message, 'text');
    const textStream = recordUtils.readAsyncIterable(textSource);
    if (textStream !== null) {
      for await (const value of textStream) {
        emitTextBlock(value, runId, identity, nextSequence, callbacks);
      }
      continue;
    }
    emitTextBlock(textSource, runId, identity, nextSequence, callbacks);
  }
}

function emitTextBlock(
  value: unknown,
  runId: string,
  identity: SubagentIdentity,
  nextSequence: () => number,
  callbacks: SubagentProjectionCallbacks
): void {
  const text = recordUtils.readNonEmptyString(value);
  if (text === null) {
    return;
  }
  emit(callbacks, runId, nextSequence(), identity, {
    kind: 'assistant_block',
    block: {
      kind: 'text',
      blockId: `${identity.subagentId}-text`,
      phase: 'delta',
      text
    }
  });
}

async function consumeToolCalls(
  calls: AsyncIterable<unknown>,
  runId: string,
  identity: SubagentIdentity,
  nextSequence: () => number,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  for await (const call of calls) {
    const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(call, 'name')) ?? 'unknown_tool';
    const callId = readToolCallId(call);
    if (callId === null) {
      continue;
    }
    const input = redactUnknown(await Promise.resolve(recordUtils.readRecordValue(call, 'input')));
    const startBlock: Extract<ChatAssistantBlock, { kind: 'tool_call' }> = {
      kind: 'tool_call',
      blockId: `${identity.subagentId}-tool-${callId}`,
      callId,
      name,
      phase: 'start',
      input
    };
    emit(callbacks, runId, nextSequence(), identity, { kind: 'tool_call', block: startBlock });
    callbacks.emitTodoEvent(input);

    try {
      const output = await Promise.resolve(recordUtils.readRecordValue(call, 'output'));
      emit(callbacks, runId, nextSequence(), identity, {
        kind: 'tool_call',
        block: {
          ...startBlock,
          phase: 'end',
          output
        }
      });
      callbacks.recordSessionToolCall?.(name, input, output);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      emit(callbacks, runId, nextSequence(), identity, {
        kind: 'tool_call',
        block: {
          ...startBlock,
          phase: 'error',
          error: message
        }
      });
      callbacks.recordSessionToolCall?.(name, input, { error: message });
    }
  }
}

function emit(
  callbacks: SubagentProjectionCallbacks,
  runId: string,
  sequence: number,
  identity: SubagentIdentity,
  event: SubagentEventPayload
): void {
  callbacks.markVisibleOutput?.();
  callbacks.emitRuntimeEvent({
    type: 'subagent_event',
    runId,
    sequence,
    identity,
    event
  });
}

function requireNonEmptyString(value: unknown, code: string): string {
  const text = recordUtils.readNonEmptyString(value);
  if (text === null) {
    throw new Error(code);
  }
  return text;
}
