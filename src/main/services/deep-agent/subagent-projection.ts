import type { ChatAssistantBlock, ChatRunEvent, SubagentEventPayload, SubagentIdentity } from '../../../shared/types';
import { toolCallAssistantBlockSchema } from '../../../shared/schemas/task-event';
import type {
  DeepAgentDomainEvent,
  DeepAgentSubagentScope
} from './deep-agent-stream-adapter';

export type SubagentProjectionCallbacks = {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  markVisibleOutput?: () => void;
  recordSessionToolCall?: (name: string, input: unknown, output: unknown) => void;
};

type DomainToolCallEvent = Extract<
  DeepAgentDomainEvent,
  { type: 'tool_call_started' | 'tool_call_completed' | 'tool_call_failed' }
>;

type DomainSubagentEvent = Exclude<DeepAgentDomainEvent, { type: 'usage' | 'run_interrupted' }>;

export function projectSubagentEvent(input: {
  event: DomainSubagentEvent & { scope: DeepAgentSubagentScope };
  runId: string;
  sequence: number;
  callbacks: SubagentProjectionCallbacks;
}): void {
  const identity = toSubagentIdentity(input.runId, input.event.scope);
  if (input.event.type === 'subagent_started') {
    emit(input.callbacks, input.runId, input.sequence, identity, { kind: 'started' });
    return;
  }
  if (input.event.type === 'subagent_completed') {
    emit(input.callbacks, input.runId, input.sequence, identity, { kind: 'completed', summary: null });
    return;
  }
  if (input.event.type === 'subagent_failed') {
    emit(input.callbacks, input.runId, input.sequence, identity, {
      kind: 'failed',
      error: input.event.error
    });
    return;
  }
  if (input.event.type === 'assistant_delta') {
    emit(input.callbacks, input.runId, input.sequence, identity, {
      kind: 'assistant_block',
      block: {
        kind: input.event.kind,
        blockId: `${identity.subagentId}-${input.event.kind}`,
        phase: 'delta',
        text: input.event.text
      }
    });
    return;
  }
  projectToolCallEvent({
    blockId: `${identity.subagentId}-tool-${input.event.callId}`,
    callbacks: input.callbacks,
    event: input.event,
    emit: (block) => {
      emit(input.callbacks, input.runId, input.sequence, identity, { kind: 'tool_call', block });
    }
  });
}

export function projectToolCallEvent(input: {
  event: DomainToolCallEvent;
  blockId: string;
  callbacks: SubagentProjectionCallbacks;
  emit: (block: Extract<ChatAssistantBlock, { kind: 'tool_call' }>) => void;
}): void {
  if (input.event.type === 'tool_call_started') {
    input.emit(toolCallAssistantBlockSchema.parse({
      kind: 'tool_call',
      blockId: input.blockId,
      callId: input.event.callId,
      name: input.event.name,
      phase: 'start',
      input: input.event.input
    }));
    return;
  }
  if (input.event.type === 'tool_call_completed') {
    const block = toolCallAssistantBlockSchema.parse({
      kind: 'tool_call',
      blockId: input.blockId,
      callId: input.event.callId,
      name: input.event.name,
      phase: 'end',
      input: input.event.input,
      output: input.event.output
    });
    input.emit(block);
    input.callbacks.recordSessionToolCall?.(input.event.name, input.event.input, input.event.output);
    return;
  }
  const block = toolCallAssistantBlockSchema.parse({
    kind: 'tool_call',
    blockId: input.blockId,
    callId: input.event.callId,
    name: input.event.name,
    phase: 'error',
    input: input.event.input,
    error: input.event.error
  });
  input.emit(block);
  input.callbacks.recordSessionToolCall?.(input.event.name, input.event.input, { error: input.event.error });
}

function toSubagentIdentity(runId: string, scope: DeepAgentSubagentScope): SubagentIdentity {
  const parentPath = scope.ordinalPath.slice(0, -1);
  return {
    subagentId: `subagent-${runId}-${scope.ordinalPath.join('-')}`,
    parentSubagentId: parentPath.length === 0 ? null : `subagent-${runId}-${parentPath.join('-')}`,
    name: scope.name,
    depth: scope.ordinalPath.length - 1,
    path: [...scope.path],
    execution: 'sync',
    taskInput: null
  };
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
