import type { ChatAssistantBlock, ChatRunEvent, SubagentEventPayload, SubagentIdentity } from '../../../shared/types';
import {
  DeepAgents110V3ContractError,
  type DeepAgents110V3Message,
  type DeepAgents110V3Subagent,
  type DeepAgents110V3ToolCall,
  type DeepAgents110V3Usage
} from './deep-agents-1-10-stream-adapter';
import { redact } from './redact';
import { redactUnknown } from './stream-tool-utils';
import type { ToolOutputProjector } from './tool-output-projection';

export type SubagentProjectionCallbacks = {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  emitTodoEvent: (candidate: unknown) => void;
  markVisibleOutput?: () => void;
  observeMessageUsage?: (usageKey: string, usage: DeepAgents110V3Usage) => void;
  projectToolOutput: ToolOutputProjector;
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
  subagents: AsyncIterable<DeepAgents110V3Subagent>;
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
  subagents: AsyncIterable<DeepAgents110V3Subagent>,
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
  subagent: DeepAgents110V3Subagent,
  ordinal: number,
  context: ProjectionContext,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  const outputSettlement = Promise.allSettled([subagent.output] as const);
  const idSegments = [...context.idSegments, ordinal];
  const subagentId = `subagent-${context.runId}-${idSegments.join('-')}`;
  const path = [...context.path, `${subagent.name}#${ordinal}`];
  const identity: SubagentIdentity = {
    subagentId,
    parentSubagentId: context.parent === null ? null : context.parent.subagentId,
    name: subagent.name,
    depth: context.path.length,
    path,
    execution: 'sync',
    taskInput: null
  };

  emit(callbacks, context.runId, context.nextSequence(), identity, { kind: 'started' });

  await Promise.all([
    consumeMessages(subagent.messages, context.runId, identity, context.nextSequence, callbacks),
    consumeToolCalls(subagent.toolCalls, context.runId, identity, context.nextSequence, callbacks),
    consumeSubagents(
      subagent.subagents,
      {
        idSegments,
        nextSequence: context.nextSequence,
        parent: identity,
        path,
        runId: context.runId
      },
      callbacks
    )
  ]);

  const [settledOutput] = await outputSettlement;
  if (settledOutput.status === 'rejected') {
    const error = settledOutput.reason;
    if (error instanceof DeepAgents110V3ContractError) {
      throw error;
    }
    emit(callbacks, context.runId, context.nextSequence(), identity, {
      kind: 'failed',
      error: redact(error instanceof Error ? error.message : String(error))
    });
    return;
  }
  emit(callbacks, context.runId, context.nextSequence(), identity, {
    kind: 'completed',
    summary: null
  });
}

async function consumeMessages(
  messages: AsyncIterable<DeepAgents110V3Message>,
  runId: string,
  identity: SubagentIdentity,
  nextSequence: () => number,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  for await (const message of messages) {
    await Promise.all([
      consumeMessageText(message, runId, identity, nextSequence, callbacks),
      consumeMessageUsage(message, callbacks),
      drainStrings(message.reasoning),
      message.trailingReasoning.then(() => undefined)
    ]);
  }
}

async function consumeMessageText(
  message: DeepAgents110V3Message,
  runId: string,
  identity: SubagentIdentity,
  nextSequence: () => number,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  for await (const text of message.text) {
    if (text.length === 0) {
      continue;
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
}

async function consumeMessageUsage(
  message: DeepAgents110V3Message,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  for await (const usage of message.usage) {
    callbacks.observeMessageUsage?.(message.usageKey, usage);
  }
}

async function drainStrings(values: AsyncIterable<string>): Promise<void> {
  for await (const _value of values) {
    void _value;
  }
}

async function consumeToolCalls(
  calls: AsyncIterable<DeepAgents110V3ToolCall>,
  runId: string,
  identity: SubagentIdentity,
  nextSequence: () => number,
  callbacks: SubagentProjectionCallbacks
): Promise<void> {
  for await (const call of calls) {
    const outcomeSettlement = Promise.allSettled([call.outcome] as const);
    const input = redactUnknown(call.input);
    const startBlock: Extract<ChatAssistantBlock, { kind: 'tool_call' }> = {
      kind: 'tool_call',
      blockId: `${identity.subagentId}-tool-${call.callId}`,
      callId: call.callId,
      name: call.name,
      phase: 'start',
      input
    };
    emit(callbacks, runId, nextSequence(), identity, { kind: 'tool_call', block: startBlock });
    callbacks.emitTodoEvent(input);

    let outcome: Awaited<DeepAgents110V3ToolCall['outcome']>;
    const [settledOutcome] = await outcomeSettlement;
    if (settledOutcome.status === 'rejected') {
      const error = settledOutcome.reason;
      if (error instanceof DeepAgents110V3ContractError) {
        throw error;
      }
      outcome = {
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
    } else {
      outcome = settledOutcome.value;
    }
    if (outcome.status === 'error') {
      const message = callbacks.projectToolOutput({
        callId: call.callId,
        name: call.name,
        output: redact(outcome.error)
      });
      emit(callbacks, runId, nextSequence(), identity, {
        kind: 'tool_call',
        block: {
          ...startBlock,
          phase: 'error',
          error: message
        }
      });
      callbacks.recordSessionToolCall?.(call.name, input, { error: message });
      continue;
    }
    const output = callbacks.projectToolOutput({
      callId: call.callId,
      name: call.name,
      output: outcome.output
    });
    emit(callbacks, runId, nextSequence(), identity, {
      kind: 'tool_call',
      block: {
        ...startBlock,
        phase: 'end',
        output
      }
    });
    callbacks.recordSessionToolCall?.(call.name, input, output);
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
