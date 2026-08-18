import type { ChatRunEvent, TaskRun } from '../../../shared/types';
import { toolCallAssistantBlockSchema } from '../../../shared/schemas/task-event';
import {
  DeepAgents110V3ContractError,
  type DeepAgents110V3Message,
  type DeepAgents110V3Subagent,
  type DeepAgents110V3ToolCall,
  type DeepAgents110V3Usage
} from './deep-agents-1-10-stream-adapter';
import * as recordUtils from './record-utils';
import { redact } from './redact';
import { projectSubagentStream } from './subagent-projection';
import { redactUnknown } from './stream-tool-utils';
import type { ToolOutputProjector } from './tool-output-projection';
import {
  createUsageAccumulator,
  updateUsageAccumulator,
  type ProviderUsageAccumulator
} from './stream-usage-accumulator';

export { createUsageAccumulator };
export type { ProviderUsageAccumulator };

type StreamConsumerContext = {
  runId: string;
  taskRun: TaskRun | null;
};

type StreamConsumerCallbacks = {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  emitTodoEvent: (candidate: unknown) => void;
  markVisibleOutput?: () => void;
  projectToolOutput: ToolOutputProjector;
  recordSessionToolCall?: (name: string, input: unknown, output: unknown) => void;
};

export async function consumeMessageStream(input: {
  messages: AsyncIterable<DeepAgents110V3Message>;
  context: StreamConsumerContext;
  assistantChunks: string[];
  reasoningChunks: string[];
  usageAccumulator: ProviderUsageAccumulator;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  for await (const message of input.messages) {
    let streamedReasoning = false;
    const [, , , trailingReasoning] = await Promise.all([
      consumeUsageStream(message.usageKey, message.usage, input.usageAccumulator),
      consumeVisibleTextStream(message.reasoning, (delta) => {
        streamedReasoning = true;
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
      }),
      consumeVisibleTextStream(message.text, (delta) => {
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
      }),
      message.trailingReasoning
    ]);

    if (!streamedReasoning && input.reasoningChunks.length === 0) {
      if (trailingReasoning !== null) {
        await consumeVisibleTextStream(singleString(trailingReasoning), (delta) => {
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
  calls: AsyncIterable<DeepAgents110V3ToolCall>;
  context: StreamConsumerContext;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  for await (const call of input.calls) {
    const outcomeSettlement = Promise.allSettled([call.outcome] as const);
    const callInput = redactUnknown(call.input);
    input.callbacks.markVisibleOutput?.();
    input.callbacks.emitRuntimeEvent({
      type: 'assistant_block',
      runId: input.context.runId,
      block: toolCallAssistantBlockSchema.parse({
        kind: 'tool_call',
        blockId: `tool-${call.callId}`,
        callId: call.callId,
        name: call.name,
        phase: 'start',
        input: callInput
      })
    });
    input.callbacks.emitTodoEvent(callInput);

    let outcome: Awaited<DeepAgents110V3ToolCall['outcome']>;
    const [settledOutcome] = await outcomeSettlement;
    if (settledOutcome.status === 'rejected') {
      const error = settledOutcome.reason;
      if (error instanceof DeepAgents110V3ContractError) {
        throw error;
      }
      outcome = {
        status: 'error',
        error: error instanceof Error ? error.message : 'Tool 执行失败。'
      };
    } else {
      outcome = settledOutcome.value;
    }
    if (outcome.status === 'error') {
      const message = input.callbacks.projectToolOutput({
        callId: call.callId,
        name: call.name,
        output: redact(outcome.error)
      });
      input.callbacks.markVisibleOutput?.();
      input.callbacks.emitRuntimeEvent({
        type: 'assistant_block',
        runId: input.context.runId,
        block: toolCallAssistantBlockSchema.parse({
          kind: 'tool_call',
          blockId: `tool-${call.callId}`,
          callId: call.callId,
          name: call.name,
          phase: 'error',
          input: callInput,
          error: message
        })
      });
      input.callbacks.recordSessionToolCall?.(call.name, callInput, { error: message });
      continue;
    }
    const output = input.callbacks.projectToolOutput({
      callId: call.callId,
      name: call.name,
      output: outcome.output
    });
    input.callbacks.markVisibleOutput?.();
    input.callbacks.emitRuntimeEvent({
      type: 'assistant_block',
      runId: input.context.runId,
      block: toolCallAssistantBlockSchema.parse({
        kind: 'tool_call',
        blockId: `tool-${call.callId}`,
        callId: call.callId,
        name: call.name,
        phase: 'end',
        input: callInput,
        output
      })
    });
    input.callbacks.recordSessionToolCall?.(call.name, callInput, output);
    input.callbacks.emitTodoEvent(output);
  }
}

export async function consumeSubagentStream(input: {
  subagents: AsyncIterable<DeepAgents110V3Subagent>;
  context: StreamConsumerContext;
  usageAccumulator: ProviderUsageAccumulator;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  await projectSubagentStream({
    subagents: input.subagents,
    runId: input.context.runId,
    callbacks: {
      ...input.callbacks,
      observeMessageUsage: (usageKey, usage) =>
        updateUsageAccumulator(input.usageAccumulator, usageKey, usage)
    }
  });
}

async function consumeUsageStream(
  usageKey: string,
  usage: AsyncIterable<DeepAgents110V3Usage>,
  accumulator: ProviderUsageAccumulator
): Promise<void> {
  for await (const observation of usage) {
    updateUsageAccumulator(accumulator, usageKey, observation);
  }
}

async function consumeVisibleTextStream(
  stream: AsyncIterable<string>,
  onDelta: (delta: string) => void
): Promise<void> {
  let pending = '';
  let released = false;
  let suppressMessage = false;

  for await (const delta of stream) {
    if (delta.length === 0 || suppressMessage) {
      continue;
    }
    if (released) {
      onDelta(delta);
      continue;
    }

    pending += delta;
    const classification = recordUtils.classifyStreamedAssistantText(pending);
    if (classification === 'non_assistant') {
      pending = '';
      suppressMessage = true;
      continue;
    }
    if (classification === 'pending') {
      continue;
    }

    released = true;
    if (pending.length > 0) {
      onDelta(pending);
    }
    pending = '';
  }

  if (!released && !suppressMessage && pending.length > 0) {
    onDelta(pending);
  }
}

async function* singleString(value: string): AsyncGenerator<string> {
  yield value;
}
