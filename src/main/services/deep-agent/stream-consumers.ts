import type { ChatRunEvent } from '../../../shared/types';
import type { DeepAgentDomainEvent, DeepAgentInterrupt } from './deep-agents-1-10-stream-adapter';
import { projectSubagentEvent, projectToolCallEvent } from './subagent-projection';
import { updateUsageAccumulator, type ProviderUsageAccumulator } from './stream-usage-accumulator';

export { createUsageAccumulator } from './stream-usage-accumulator';
export type { ProviderUsageAccumulator } from './stream-usage-accumulator';

export type StreamConsumerCallbacks = {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  markVisibleOutput?: () => void;
  recordSessionToolCall?: (name: string, input: unknown, output: unknown) => void;
};

export type StreamConsumerState = {
  assistantChunks: string[];
  reasoningChunks: string[];
  usageAccumulator: ProviderUsageAccumulator;
  interrupted: readonly DeepAgentInterrupt[] | null;
  subagentSequence: number;
};

export async function consumeDeepAgentEventStream(input: {
  events: AsyncIterable<DeepAgentDomainEvent>;
  state: StreamConsumerState;
  runId: string;
  callbacks: StreamConsumerCallbacks;
}): Promise<void> {
  for await (const event of input.events) {
    consumeDeepAgentEvent({
      event,
      runId: input.runId,
      state: input.state,
      callbacks: input.callbacks
    });
  }
}

function consumeDeepAgentEvent(input: {
  event: DeepAgentDomainEvent;
  runId: string;
  state: StreamConsumerState;
  callbacks: StreamConsumerCallbacks;
}): void {
  const { event, callbacks, state } = input;
  if (event.type === 'usage') {
    updateUsageAccumulator(state.usageAccumulator, event.usageKey, event.usage);
    return;
  }
  if (event.type === 'assistant_delta') {
    if (event.scope !== null) {
      const sequence = ++state.subagentSequence;
      const scopedEvent = { ...event, scope: event.scope };
      projectSubagentEvent({
        callbacks,
        event: scopedEvent,
        runId: input.runId,
        sequence
      });
      return;
    }
    callbacks.markVisibleOutput?.();
    if (event.kind === 'reasoning') {
      state.reasoningChunks.push(event.text);
    } else {
      state.assistantChunks.push(event.text);
    }
    callbacks.emitRuntimeEvent({
      type: 'assistant_block',
      runId: input.runId,
      block: {
        kind: event.kind === 'reasoning' ? 'reasoning' : 'text',
        blockId: `${event.kind}-${input.runId}`,
        phase: 'delta',
        text: event.text
      }
    });
    return;
  }
  if (event.type === 'run_interrupted') {
    state.interrupted = event.interrupts;
    return;
  }
  if (event.type === 'subagent_started' || event.type === 'subagent_completed' || event.type === 'subagent_failed') {
    const sequence = ++state.subagentSequence;
    projectSubagentEvent({
      callbacks,
      event,
      runId: input.runId,
      sequence
    });
    return;
  }
  if (event.scope !== null) {
    const sequence = ++state.subagentSequence;
    const scopedEvent = { ...event, scope: event.scope };
    projectSubagentEvent({
      callbacks,
      event: scopedEvent,
      runId: input.runId,
      sequence
    });
    return;
  }
  const blockId = `tool-${event.callId}`;
  callbacks.markVisibleOutput?.();
  projectToolCallEvent({
    blockId,
    callbacks,
    event,
    emit: (block) => {
      callbacks.emitRuntimeEvent({
        type: 'assistant_block',
        runId: input.runId,
        block
      });
    }
  });
}

export function createStreamConsumerState(input: {
  assistantChunks: string[];
  reasoningChunks: string[];
  usageAccumulator: ProviderUsageAccumulator;
}): StreamConsumerState {
  return {
    assistantChunks: input.assistantChunks,
    reasoningChunks: input.reasoningChunks,
    usageAccumulator: input.usageAccumulator,
    interrupted: null,
    subagentSequence: 0
  };
}
